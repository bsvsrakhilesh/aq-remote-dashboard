-- Align database behavior with 15-minute logger heartbeat, telemetry and command polling.
-- Keep existing signatures and grants while replacing only cadence-dependent logic.
begin;

create or replace function public.queue_csv_history() returns void language plpgsql security definer set search_path = '' as $$
declare
  j record;
  request_id uuid;
  active_count integer;
  cutoff timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')
    + case when extract(hour from now() at time zone 'Asia/Kolkata') >= 12
      then interval '12 hours' else interval '0 hours' end) at time zone 'Asia/Kolkata';
begin
  if not pg_try_advisory_xact_lock(92625001) then return; end if;
  insert into public.csv_history_settings(device_id) select id from public.devices on conflict do nothing;

  -- Reclaim crashed workers or expired/failed transfers. Never cancel a manual request.
  for j in select h.id, h.download_request_id, h.attempts from public.csv_history_jobs h
    left join public.download_requests d on d.id = h.download_request_id
    where (h.status = 'processing' and h.lease_until < now())
       or (h.status = 'waiting' and (d.status in ('failed','expired') or
         (d.status <> 'ready' and d.created_at < now() - interval '50 minutes')))
  loop
    update public.download_requests set status = 'failed', error_message = 'Automatic CSV sync will retry'
      where id = j.download_request_id and request_kind = 'minute_history' and status <> 'expired';
    update public.device_commands set status = 'expired', error_message = 'Automatic CSV sync timed out'
      where payload->>'request_id' = j.download_request_id::text and status in ('queued','acknowledged','running');
    update public.csv_history_jobs set status = case when attempts < 3 then 'queued' else 'failed' end,
      retry_at = now() + interval '15 minutes', lease_token = null, lease_until = null,
      error_message = 'CSV transfer or processing timed out. Retrying when the logger is available.' where id = j.id;
  end loop;

  -- Skip offline devices; the next full weekly snapshot includes missed hours.
  insert into public.csv_history_jobs(device_id, filename, hour_end)
    select d.id, d.current_filename, cutoff from public.devices d
    join public.csv_history_settings s on s.device_id = d.id and s.enabled
    where d.last_seen > now() - interval '40 minutes'
      and d.current_filename ~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$'
      and (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata') < cutoff
    on conflict do nothing;

  -- At weekly rollover, take one final snapshot of the previously synced file.
  insert into public.csv_history_jobs(device_id, filename, hour_end)
    select d.id, sync.source_filename,
      (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata')
    from public.devices d join public.csv_history_settings s on s.device_id = d.id and s.enabled
    join public.minute_history_sync sync on sync.device_id = d.id
    where d.last_seen > now() - interval '40 minutes' and sync.source_filename <> d.current_filename
      and d.current_filename ~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$'
      and sync.latest_minute >= cutoff - interval '8 days'
    on conflict do nothing;

  update public.csv_history_jobs set status = 'failed', error_message = 'Sync request became too old; the next weekly snapshot will be used.'
    where status = 'queued' and created_at < now() - interval '8 days';
  select count(*) into active_count from public.download_requests where request_kind = 'minute_history'
    and status in ('queued','device_acknowledged','uploading');
  for j in select h.* from public.csv_history_jobs h
    join public.csv_history_settings s on s.device_id = h.device_id and s.enabled
    join public.devices dev on dev.id = h.device_id and dev.last_seen > now() - interval '40 minutes'
    where h.status = 'queued' and h.retry_at <= now() and h.attempts < 3
    order by h.created_at limit 30
  loop
    exit when active_count >= 3;
    if exists(select 1 from public.download_requests where device_id = j.device_id
      and status in ('queued','device_acknowledged','uploading')) then continue; end if;
    if exists(select 1 from public.csv_history_jobs where device_id = j.device_id and status in ('waiting','processing')) then continue; end if;
    insert into public.download_requests(device_id, filename, created_by, request_kind)
      values (j.device_id, j.filename, null, 'minute_history') returning id into request_id;
    insert into public.device_commands(device_id, command_type, payload)
      values (j.device_id, 'download_file', jsonb_build_object('filename', j.filename, 'request_id', request_id));
    update public.csv_history_jobs set status = 'waiting', attempts = attempts + 1, download_request_id = request_id,
      error_message = null where id = j.id;
    active_count := active_count + 1;
  end loop;
end;
$$;

create or replace function public.evaluate_research_alerts() returns void
language plpgsql security definer set search_path='' as $$
declare rule record; triggered boolean; n integer; total integer; hits integer; oldest timestamptz; newest timestamptz; value real; longest_gap interval;
begin
 if not pg_try_advisory_xact_lock(92625003) then return; end if;
 for rule in select r.*,d.device_code,d.last_seen,d.co2_enabled from public.alert_rules r
   join public.devices d on d.id=r.device_id loop
  triggered:=false; value:=null;
  if rule.enabled then
   if rule.metric='offline' then
    value:=extract(epoch from now()-coalesce(rule.last_seen,rule.created_at))/60;
    triggered:=value>=rule.duration_minutes;
   elsif rule.metric<>'co2' or rule.co2_enabled then
    -- Evaluate existing fifteen-minute snapshots, not delayed twice-daily CSVs.
    -- Require full-window coverage and a fresh final sample; missing data never
    -- implies a threshold breach. The offline rule handles connectivity loss.
    select count(v),count(*),count(*) filter(where case when rule.direction='above' then v>rule.threshold else v<rule.threshold end),
      min(timestamp),max(timestamp),(array_agg(v order by timestamp desc))[1],max(gap)
    into n,total,hits,oldest,newest,value,longest_gap from (
     select t.timestamp,t.timestamp-lag(t.timestamp) over(order by t.timestamp) gap,case rule.metric when 'pm1' then t.pm1 when 'pm25' then t.pm25
       when 'pm10' then t.pm10 when 'temperature' then t.temperature_c when 'rh' then t.rh when 'co2' then t.co2_ppm end v
     from public.telemetry_5min t where t.device_id=rule.device_id
       and t.timestamp>=now()-make_interval(mins=>rule.duration_minutes+15) and t.timestamp<=now()
    ) values_in_window;
    if n=total and n>=greatest(2,ceil(rule.duration_minutes/15.0)::integer)
      and oldest<=now()-make_interval(mins=>rule.duration_minutes)
      and newest>=now()-interval '20 minutes' and longest_gap<=interval '20 minutes' then
      triggered:=hits=n;
    else
      -- Unknown coverage neither opens nor resolves an existing threshold alert.
      triggered:=null;
    end if;
   end if;
  end if;
  if triggered then
   insert into public.alert_events(rule_id,device_id,metric,observed_value,message)
   values(rule.id,rule.device_id,rule.metric,value,
    case when rule.metric='offline' then rule.device_code||' has not reported for '||rule.duration_minutes||' minutes'
    else rule.device_code||': '||rule.metric||' remained '||rule.direction||' '||rule.threshold||' for '||rule.duration_minutes||' minutes' end)
   on conflict(rule_id) where resolved_at is null do update set observed_value=excluded.observed_value;
  elsif triggered=false then
   update public.alert_events set resolved_at=now() where rule_id=rule.id and resolved_at is null;
  end if;
 end loop;
end $$;

create or replace function public.request_history_sync(p_device uuid) returns text
language plpgsql security definer set search_path='' as $$
declare d public.devices; s public.csv_history_settings; cutoff timestamptz;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_device::text,92625004));
 select * into d from public.devices where id=p_device;
 if not found then raise exception 'Logger not found'; end if;
 if d.last_seen is null or d.last_seen<now()-interval '40 minutes' then raise exception 'Logger is offline. Try again when it reports.'; end if;
 if d.current_filename is null or d.current_filename !~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$' then raise exception 'No verified weekly CSV is available'; end if;
 insert into public.csv_history_settings(device_id) values(p_device) on conflict do nothing;
 select * into s from public.csv_history_settings where device_id=p_device for update;
 if not s.enabled then raise exception 'Resume automatic sync before requesting a refresh'; end if;
 if s.last_manual_at>now()-interval '15 minutes' then raise exception 'Please allow 15 minutes between manual requests'; end if;
 if exists(select 1 from public.csv_history_jobs where device_id=p_device and status in ('queued','waiting','processing'))
   or exists(select 1 from public.download_requests where device_id=p_device and status in ('queued','device_acknowledged','uploading')) then
   raise exception 'A transfer is already pending for this logger';
 end if;
 cutoff:=(date_trunc('day',now() at time zone 'Asia/Kolkata')+case when extract(hour from now() at time zone 'Asia/Kolkata')>=12 then interval '12 hours' else interval '0 hours' end) at time zone 'Asia/Kolkata';
 if (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata')>=cutoff then raise exception 'The new weekly file has no completed scheduled window yet'; end if;
 insert into public.csv_history_jobs(device_id,filename,hour_end) values(p_device,d.current_filename,cutoff)
 on conflict(device_id,filename,hour_end) do update set status='queued',attempts=0,retry_at=now(),error_message=null,
   download_request_id=null,completed_at=null,lease_token=null,lease_until=null;
 update public.csv_history_settings set last_manual_at=now() where device_id=p_device;
 return 'CSV refresh queued for the latest midnight/noon cutoff. Your SD files are unchanged.';
end $$;

create or replace function public.fleet_reliability(p_days integer)
returns table (
  device_id uuid,
  expected_snapshots bigint,
  reported_snapshots bigint,
  expected_minutes bigint,
  recorded_minutes bigint,
  failed_syncs bigint,
  completed_syncs bigint,
  latest_failure_at timestamptz,
  retention_days integer
)
language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_days is null or p_days not in (7, 30) then
    raise exception 'Choose a 7- or 30-day period';
  end if;

  return query
  with bounds as (
    select (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') as until_at
  )
  select d.id,
    greatest(0::bigint, floor(extract(epoch from b.until_at) / 900)::bigint -
      floor(extract(epoch from greatest(d.created_at, b.until_at - make_interval(days => p_days))) / 900)::bigint),
    coalesce(s.reported, 0),
    greatest(0::bigint, floor(extract(epoch from b.until_at) / 60)::bigint -
      floor(extract(epoch from greatest(d.created_at, b.until_at - make_interval(days => p_days),
        coalesce(now() - make_interval(days => r.days), b.until_at - make_interval(days => p_days)))) / 60)::bigint),
    coalesce(m.recorded, 0),
    coalesce(j.failed, 0),
    coalesce(j.completed, 0),
    j.latest_failure,
    r.days
  from public.devices d cross join bounds b
  left join public.history_retention r on r.device_id = d.id
  left join lateral (
    select count(distinct floor(extract(epoch from t."timestamp") / 900)::bigint) as reported
    from public.telemetry_5min t
    where t.device_id = d.id
      and t."timestamp" >= greatest(d.created_at, b.until_at - make_interval(days => p_days))
      and t."timestamp" < b.until_at
  ) s on true
  left join lateral (
    select count(*) as recorded from public.telemetry_1min t
    where t.device_id = d.id
      and t."timestamp" >= greatest(d.created_at, b.until_at - make_interval(days => p_days),
        coalesce(now() - make_interval(days => r.days), b.until_at - make_interval(days => p_days)))
      and t."timestamp" < b.until_at
  ) m on true
  left join lateral (
    select count(*) filter (where h.status = 'failed') as failed,
      count(*) filter (where h.status = 'completed') as completed,
      max(coalesce(h.completed_at, h.created_at)) filter (where h.status = 'failed') as latest_failure
    from public.csv_history_jobs h
    where h.device_id = d.id
      and h.created_at >= greatest(d.created_at, b.until_at - make_interval(days => p_days))
      and h.created_at < b.until_at
  ) j on true
  order by d.device_code;
end $$;

comment on function public.fleet_reliability(integer) is
  'Fleet reporting-slot and imported-minute coverage for the last 7 or 30 completed IST days. Snapshot slots are 15 minutes. Starts no earlier than registration; minute denominators respect configured retention. Reporting slots are not proof of electrical uptime.';

commit;
