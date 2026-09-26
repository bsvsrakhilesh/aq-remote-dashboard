begin;
alter table public.csv_history_settings add column last_manual_at timestamptz;
create function public.request_history_sync(p_device uuid) returns text
language plpgsql security definer set search_path='' as $$
declare d public.devices; s public.csv_history_settings; cutoff timestamptz;
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_device::text,92625004));
 select * into d from public.devices where id=p_device;
 if not found then raise exception 'Logger not found'; end if;
 if d.last_seen is null or d.last_seen<now()-interval '10 minutes' then raise exception 'Logger is offline. Try again when it reports.'; end if;
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
revoke all on function public.request_history_sync(uuid) from public,anon;
grant execute on function public.request_history_sync(uuid) to authenticated;

create table public.history_retention (
 device_id uuid primary key references public.devices(id) on delete cascade,
 days integer check(days between 7 and 3650), updated_at timestamptz not null default now(),
 updated_by uuid references auth.users(id)
);
alter table public.history_retention enable row level security;
revoke all on public.history_retention from anon,authenticated;
grant select on public.history_retention to authenticated;
create policy "researchers read retention" on public.history_retention for select to authenticated using(true);
create table public.retention_audit (
 id uuid primary key default gen_random_uuid(),device_id uuid references public.devices(id) on delete set null,
 days integer,changed_by uuid references auth.users(id),changed_at timestamptz not null default now(),
 deleted_points integer not null default 0
);
alter table public.retention_audit enable row level security;
revoke all on public.retention_audit from anon,authenticated;
grant select on public.retention_audit to authenticated;
create policy "researchers read retention audit" on public.retention_audit for select to authenticated using(true);

create function public.history_storage_summary() returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 return jsonb_build_object('database_bytes',pg_database_size(current_database()),'minute_table_bytes',pg_total_relation_size('public.telemetry_1min'),
 'snapshot_table_bytes',pg_total_relation_size('public.telemetry_5min'),'devices',(
 select coalesce(jsonb_agg(v),'[]') from (select d.id device_id,d.device_code,r.days,
 (select count(*) from public.telemetry_1min t where t.device_id=d.id) minute_points,
 (select min(timestamp) from public.telemetry_1min t where t.device_id=d.id) oldest_minute,
 (select max(timestamp) from public.telemetry_1min t where t.device_id=d.id) latest_minute
 from public.devices d left join public.history_retention r on r.device_id=d.id order by d.device_code) v));
end $$;
create function public.preview_history_retention(p_device uuid,p_days integer) returns bigint
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_days is null then return 0; end if;
 if p_days not between 7 and 3650 then raise exception 'Retention must be 7-3650 days'; end if;
 return (select count(*) from public.telemetry_1min where device_id=p_device and timestamp<now()-make_interval(days=>p_days));
end $$;
create function public.set_history_retention(p_device uuid,p_days integer,p_confirm boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 if p_confirm is distinct from true then raise exception 'Explicit confirmation required'; end if;
 if p_days is not null and p_days not between 7 and 3650 then raise exception 'Retention must be 7-3650 days'; end if;
 insert into public.history_retention(device_id,days,updated_by) values(p_device,p_days,auth.uid())
 on conflict(device_id) do update set days=excluded.days,updated_at=now(),updated_by=auth.uid();
 insert into public.retention_audit(device_id,days,changed_by) values(p_device,p_days,auth.uid());
end $$;
create function public.apply_history_retention() returns void
language plpgsql security definer set search_path='' as $$
declare r record; deleted integer;
begin
 if not pg_try_advisory_xact_lock(92625005) then return; end if;
 for r in select * from public.history_retention where days is not null loop
  with doomed as (select timestamp from public.telemetry_1min where device_id=r.device_id and timestamp<now()-make_interval(days=>r.days) order by timestamp limit 5000)
  delete from public.telemetry_1min t using doomed where t.device_id=r.device_id and t.timestamp=doomed.timestamp;
  get diagnostics deleted=row_count;
  if deleted>0 then insert into public.retention_audit(device_id,days,deleted_points) values(r.device_id,r.days,deleted); end if;
 end loop;
end $$;
revoke all on function public.history_storage_summary(),public.preview_history_retention(uuid,integer),public.set_history_retention(uuid,integer,boolean),public.apply_history_retention() from public,anon,authenticated;
grant execute on function public.history_storage_summary(),public.preview_history_retention(uuid,integer),public.set_history_retention(uuid,integer,boolean) to authenticated;
grant all on public.history_retention,public.retention_audit to service_role;
select cron.schedule('minute-history-retention','15 * * * *','select public.apply_history_retention();');
commit;
