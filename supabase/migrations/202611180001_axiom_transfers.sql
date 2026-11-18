begin;

alter table public.download_requests drop constraint download_requests_request_kind_check;
alter table public.download_requests add constraint download_requests_request_kind_check
  check (request_kind in ('manual', 'minute_history', 'axiom'));

create table public.axiom_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  device_id uuid not null references public.devices(id),
  kind text not null check (kind in ('raw', 'minute')),
  filename text not null,
  source_key text not null,
  status text not null default 'queued' check (status in
    ('queued', 'waiting_logger', 'transferring', 'ready', 'failed')),
  request_id uuid references public.download_requests(id) on delete set null,
  payload text,
  source_bytes integer not null,
  row_count integer,
  expected_minutes integer,
  minute_start timestamptz,
  minute_end timestamptz,
  attempts integer not null default 0,
  lease_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  error_code text,
  checksum text,
  check (source_bytes > 0 and source_bytes <= 41943040)
);
create index axiom_jobs_runnable on public.axiom_jobs (next_attempt_at, created_at)
  where status in ('queued', 'waiting_logger', 'transferring');
create index axiom_jobs_owner on public.axiom_jobs (owner_id, created_at desc);
create unique index axiom_jobs_active_source on public.axiom_jobs (owner_id, source_key)
  where status in ('queued', 'waiting_logger', 'transferring');

create table public.axiom_usage (
  period date primary key,
  reserved_bytes bigint not null check (reserved_bytes >= 0)
);
create table public.axiom_worker_status (
  owner_id uuid primary key references auth.users(id),
  last_seen_at timestamptz,
  paused boolean not null default false
);
alter table public.axiom_jobs enable row level security;
alter table public.axiom_usage enable row level security;
alter table public.axiom_worker_status enable row level security;
revoke all on public.axiom_jobs, public.axiom_usage, public.axiom_worker_status from public, anon, authenticated;
grant all on public.axiom_jobs, public.axiom_usage, public.axiom_worker_status to service_role;

create function public.axiom_minute_snapshot(p_device uuid, p_start timestamptz, p_end timestamptz)
returns table (payload text, timestamps timestamptz[])
language sql set search_path = '' set extra_float_digits = 1 as $$
  with locked as materialized (
    select timestamp, pm1, pm25, pm10, temperature_c, rh, co2_ppm, sample_count, valid_counts
    from public.telemetry_1min where device_id = p_device and timestamp >= p_start and timestamp < p_end
    order by timestamp for share
  )
  select 'timestamp_utc,timestamp_ist,pm1_ug_m3,pm25_ug_m3,pm10_ug_m3,temperature_c,rh_percent,co2_ppm,sample_count,valid_pm1_samples,valid_pm25_samples,valid_pm10_samples,valid_temperature_samples,valid_rh_samples,valid_co2_samples'
    || E'\n' || string_agg(concat_ws(',',
      to_char(timestamp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      to_char(timestamp at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI:SS"+05:30"'),
      coalesce(pm1::text, ''), coalesce(pm25::text, ''), coalesce(pm10::text, ''),
      coalesce(temperature_c::text, ''), coalesce(rh::text, ''), coalesce(co2_ppm::text, ''),
      sample_count, coalesce(valid_counts[1], 0), coalesce(valid_counts[2], 0),
      coalesce(valid_counts[3], 0), coalesce(valid_counts[4], 0),
      coalesce(valid_counts[5], 0), coalesce(valid_counts[6], 0)), E'\n' order by timestamp) || E'\n',
    array_agg(timestamp order by timestamp)
  from locked;
$$;

create function public.create_axiom_job(
  p_owner uuid, p_device uuid, p_kind text, p_file uuid,
  p_from date, p_through date, p_preview boolean
) returns jsonb language plpgsql set search_path = '' as $$
declare
  chosen_file public.device_files%rowtype;
  job public.axiom_jobs%rowtype;
  source_name text;
  source_key_value text;
  contents text;
  contents_bytes integer;
  minute_count integer;
  expected integer;
  first_minute timestamptz;
  end_minute timestamptz;
begin
  if not exists (select 1 from public.devices where id = p_device) then
    return jsonb_build_object('error', 'device_missing');
  end if;
  if p_kind = 'raw' then
    select * into chosen_file from public.device_files where id = p_file and device_id = p_device;
    if not found or chosen_file.filename !~* '\.csv$' or chosen_file.size_bytes <= 0
      or length(chosen_file.filename) > 255 or strpos(chosen_file.filename, '/') > 0
      or strpos(chosen_file.filename, chr(92)) > 0 then
      return jsonb_build_object('error', 'file_missing');
    end if;
    if chosen_file.size_bytes > 41943040 then
      return jsonb_build_object('error', 'file_too_large');
    end if;
    source_name := chosen_file.filename;
    source_key_value := 'raw:' || chosen_file.id;
    contents_bytes := chosen_file.size_bytes;
  elsif p_kind = 'minute' then
    if p_from is null or p_through is null or p_through - p_from not between 0 and 6
      or p_through > (now() at time zone 'Asia/Kolkata')::date then
      return jsonb_build_object('error', 'invalid_range');
    end if;
    first_minute := p_from::timestamp at time zone 'Asia/Kolkata';
    end_minute := least(
      (p_through + 1)::timestamp at time zone 'Asia/Kolkata',
      (date_trunc('day', now() at time zone 'Asia/Kolkata') +
        floor(extract(hour from now() at time zone 'Asia/Kolkata') / 12) * interval '12 hours')
        at time zone 'Asia/Kolkata'
    );
    expected := greatest(0, extract(epoch from end_minute - first_minute)::integer / 60);
    if p_preview then
      select count(*) into minute_count from public.telemetry_1min
      where device_id = p_device and timestamp >= first_minute and timestamp < end_minute;
      return jsonb_build_object('rows', minute_count, 'expected', expected);
    end if;
    select payload, coalesce(cardinality(timestamps), 0) into contents, minute_count
      from public.axiom_minute_snapshot(p_device, first_minute, end_minute);
    if minute_count = 0 then return jsonb_build_object('error', 'empty_range'); end if;
    contents_bytes := octet_length(contents);
    if contents_bytes > 2097152 then return jsonb_build_object('error', 'file_too_large'); end if;
    source_name := (select device_code from public.devices where id = p_device) ||
      '_minute_' || p_from || '_' || p_through || '.csv';
    source_key_value := 'minute:' || p_device || ':' || p_from || ':' || p_through;
  else
    return jsonb_build_object('error', 'invalid_kind');
  end if;

  perform pg_advisory_xact_lock(61118001);
  if exists (select 1 from public.axiom_worker_status where owner_id = p_owner and paused) then
    return jsonb_build_object('error', 'paused');
  end if;
  select * into job from public.axiom_jobs
    where owner_id = p_owner and source_key = source_key_value
      and status in ('queued', 'waiting_logger', 'transferring');
  if found then return jsonb_build_object('id', job.id, 'status', job.status); end if;
  if (select count(*) from public.axiom_jobs where status in ('queued', 'waiting_logger', 'transferring')) >= 10
    or coalesce((select sum(octet_length(payload)) from public.axiom_jobs where payload is not null), 0)
      + coalesce(octet_length(contents), 0) > 8388608 then
    return jsonb_build_object('error', 'queue_full');
  end if;
  if coalesce((select reserved_bytes from public.axiom_usage
      where period = date_trunc('month', now() at time zone 'UTC')::date), 0) + contents_bytes > 1073741824 then
    return jsonb_build_object('error', 'budget');
  end if;
  insert into public.axiom_jobs (owner_id, device_id, kind, filename, source_key, payload,
    source_bytes, row_count, expected_minutes, minute_start, minute_end)
    values (p_owner, p_device, p_kind, source_name, source_key_value, contents,
      contents_bytes, minute_count, expected, first_minute, end_minute) returning * into job;
  return jsonb_build_object('id', job.id, 'status', job.status);
end;
$$;

create function public.claim_axiom_job(p_owner uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare
  job public.axiom_jobs%rowtype;
  transfer public.download_requests%rowtype;
  month_start date := date_trunc('month', now() at time zone 'UTC')::date;
  bytes integer;
  active_bytes bigint;
begin
  perform pg_advisory_xact_lock(61118001);
  insert into public.axiom_worker_status (owner_id, last_seen_at) values (p_owner, now())
    on conflict (owner_id) do update set last_seen_at = excluded.last_seen_at
    where public.axiom_worker_status.last_seen_at is null
      or public.axiom_worker_status.last_seen_at <= now() - interval '2 minutes';
  if exists (select 1 from public.axiom_worker_status where owner_id = p_owner and paused) then
    return null;
  end if;
  update public.axiom_jobs j set status = 'failed', finished_at = now(), payload = null,
    error_code = case
      when (select error_message from public.download_requests where id = j.request_id) = 'axiom_file_too_large'
        then 'file_too_large'
      when j.attempts >= 3 then 'retry_limit'
      else 'source_expired'
    end
    where j.status in ('queued', 'waiting_logger', 'transferring') and coalesce(j.lease_until, now()) <= now()
      and (j.created_at < now() - interval '24 hours' or j.attempts >= 3 or
        (j.request_id is not null and not exists (
          select 1 from public.download_requests d where d.id = j.request_id
            and d.status in ('queued', 'device_acknowledged', 'uploading', 'ready')
            and (d.status <> 'ready' or d.expires_at > now())
      )));
  if exists (select 1 from public.axiom_jobs where status = 'transferring' and lease_until > now()) then
    return null;
  end if;
  for job in select * from public.axiom_jobs j where j.owner_id = p_owner
    and j.status in ('queued', 'waiting_logger', 'transferring')
    and coalesce(j.lease_until, now()) <= now() and j.next_attempt_at <= now()
    order by j.created_at, j.id for update
  loop
    bytes := job.source_bytes;
    transfer := null;
    if job.kind = 'raw' then
      if job.request_id is null then
        if coalesce((select reserved_bytes from public.axiom_usage where period = month_start), 0)
          + bytes > 1073741824 then
          update public.axiom_jobs set error_code = 'budget' where id = job.id;
          continue;
        end if;
        select * into transfer from public.download_requests d
          where d.created_by = p_owner and d.device_id = job.device_id and d.filename = job.filename
            and d.request_kind = 'manual' and d.status = 'ready' and d.expires_at > now() + interval '2 minutes'
            and d.storage_path is not null and d.total_bytes = job.source_bytes
          order by d.completed_at desc limit 1;
        if not found then
          if exists (select 1 from public.axiom_jobs a where a.device_id = job.device_id
            and a.id <> job.id and a.status in ('waiting_logger', 'transferring')) then continue; end if;
          select coalesce(sum(total_bytes), 0) into active_bytes from public.download_requests
            where request_kind = 'axiom' and (storage_path is not null or
              status in ('queued', 'device_acknowledged', 'uploading'));
          if active_bytes + 41943040 > 209715200 then continue; end if;
          insert into public.download_requests (device_id, filename, created_by, request_kind, total_bytes)
            values (job.device_id, job.filename, p_owner, 'axiom', 41943040) returning * into transfer;
          insert into public.device_commands (device_id, command_type, payload)
            values (job.device_id, 'download_file', jsonb_build_object(
              'filename', job.filename, 'request_id', transfer.id));
        end if;
        update public.axiom_jobs set request_id = transfer.id, status = 'waiting_logger' where id = job.id;
      else
        select * into transfer from public.download_requests where id = job.request_id;
      end if;
      if transfer.status <> 'ready' or transfer.storage_path is null or transfer.expires_at <= now() then
        continue;
      end if;
      bytes := transfer.total_bytes;
    end if;
    insert into public.axiom_usage (period, reserved_bytes) values (month_start, 0) on conflict do nothing;
    update public.axiom_usage set reserved_bytes = reserved_bytes + bytes
      where period = month_start and reserved_bytes + bytes <= 1073741824;
    if not found then
      update public.axiom_jobs set error_code = 'budget' where id = job.id;
      continue;
    end if;
    update public.axiom_jobs set status = 'transferring', attempts = attempts + 1,
      lease_id = gen_random_uuid(), lease_until = now() + interval '10 minutes',
      error_code = null, source_bytes = bytes where id = job.id returning * into job;
    return jsonb_build_object('id', job.id, 'lease', job.lease_id, 'kind', job.kind, 'filename', job.filename,
      'device', (select device_code from public.devices where id = job.device_id),
      'bytes', bytes, 'storage_path', transfer.storage_path, 'expires_at', transfer.expires_at,
      'captured_at', coalesce(transfer.completed_at, job.created_at));
  end loop;
  return null;
end;
$$;

create function public.finish_axiom_job(
  p_owner uuid, p_job uuid, p_lease uuid, p_checksum text, p_error text, p_retry boolean
) returns boolean language plpgsql set search_path = '' as $$
declare
  job public.axiom_jobs%rowtype;
begin
  update public.axiom_jobs set
    status = case when p_checksum is not null then 'ready' when p_retry and attempts < 3 then 'queued' else 'failed' end,
    payload = case when p_checksum is null and p_retry and attempts < 3 then payload else null end,
    finished_at = case when p_checksum is null and p_retry and attempts < 3 then null else now() end,
    next_attempt_at = now() + make_interval(mins => attempts * 2),
    checksum = p_checksum, error_code = p_error, lease_id = null, lease_until = null
    where id = p_job and owner_id = p_owner and lease_id = p_lease
      and status = 'transferring' and lease_until > now() returning * into job;
  if not found then return false; end if;
  if job.status in ('ready', 'failed') and job.request_id is not null then
    update public.download_requests set expires_at = now()
      where id = job.request_id and request_kind = 'axiom' and status = 'ready';
  end if;
  return true;
end;
$$;

create function public.recover_axiom_job(p_owner uuid, p_job uuid, p_checksum text)
returns text language plpgsql set search_path = '' as $$
declare job public.axiom_jobs%rowtype;
begin
  select * into job from public.axiom_jobs where id = p_job and owner_id = p_owner for update;
  if not found then return 'missing'; end if;
  if job.status = 'ready' then
    return case when job.checksum = p_checksum then 'ready' else 'checksum_conflict' end;
  end if;
  if job.attempts = 0 then return 'not_claimed'; end if;
  update public.axiom_jobs set status = 'ready', payload = null, finished_at = now(), checksum = p_checksum,
    error_code = null, lease_id = null, lease_until = null where id = job.id;
  update public.download_requests set expires_at = now()
    where id = job.request_id and request_kind = 'axiom' and status = 'ready';
  return 'ready';
end;
$$;

-- Run by a database administrator only, after verifying a restored copy of this job.
-- Snapshot rows stay locked until commit. If any retained value changed, archive again.
create function public.prune_backed_up_axiom_minutes(p_job uuid, p_checksum text)
returns integer language plpgsql set search_path = '' as $$
declare
  job public.axiom_jobs%rowtype;
  snapshot record;
  removed integer;
begin
  select * into job from public.axiom_jobs where id = p_job and status = 'ready' and kind = 'minute'
    and minute_end <= now() - interval '30 days' and checksum = p_checksum for update;
  if not found then raise exception 'A verified minute backup older than 30 days is required'; end if;
  select * into snapshot from public.axiom_minute_snapshot(job.device_id, job.minute_start, job.minute_end);
  if snapshot.payload is null or encode(sha256(convert_to(snapshot.payload, 'UTF8')), 'hex') <> p_checksum then
    raise exception 'Cloud rows changed since the backup; archive the date range again';
  end if;
  delete from public.telemetry_1min where device_id = job.device_id and timestamp = any (snapshot.timestamps);
  get diagnostics removed = row_count;
  insert into public.retention_audit(device_id, days, deleted_points) values (job.device_id, 30, removed);
  return removed;
end;
$$;

revoke execute on function
  public.axiom_minute_snapshot(uuid, timestamptz, timestamptz),
  public.create_axiom_job(uuid, uuid, text, uuid, date, date, boolean),
  public.claim_axiom_job(uuid), public.finish_axiom_job(uuid, uuid, uuid, text, text, boolean),
  public.recover_axiom_job(uuid, uuid, text), public.prune_backed_up_axiom_minutes(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.axiom_minute_snapshot(uuid, timestamptz, timestamptz),
  public.create_axiom_job(uuid, uuid, text, uuid, date, date, boolean),
  public.claim_axiom_job(uuid), public.finish_axiom_job(uuid, uuid, uuid, text, text, boolean),
  public.recover_axiom_job(uuid, uuid, text)
  to service_role;
revoke execute on function public.prune_backed_up_axiom_minutes(uuid, text) from service_role;
select cron.schedule('axiom-job-retention', '35 3 * * *',
  $job$
  update public.axiom_jobs set status = 'failed', payload = null, finished_at = now(), error_code = 'source_expired'
    where status in ('queued', 'waiting_logger', 'transferring') and created_at < now() - interval '24 hours'
      and coalesce(lease_until, now()) <= now();
  delete from public.axiom_jobs where finished_at < now() - interval '90 days';
  delete from public.axiom_usage where period < now() - interval '12 months';
  $job$);

commit;
