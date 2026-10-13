-- Scheduled history transfers use committed byte offsets per weekly SD file.
-- Legacy firmware cannot receive an automatic transfer after this migration.
begin;

create table public.csv_history_offsets (
  device_id uuid not null references public.devices(id) on delete cascade,
  filename text not null,
  next_byte bigint not null default 0 check (next_byte >= 0),
  updated_at timestamptz not null default now(),
  primary key (device_id, filename)
);
alter table public.csv_history_offsets enable row level security;
revoke all on public.csv_history_offsets from public, anon, authenticated;
grant all on public.csv_history_offsets to service_role;

alter table public.csv_history_jobs add column start_byte bigint check (start_byte >= 0);
alter table public.download_requests
  add column source_start_byte bigint check (source_start_byte >= 0),
  add column source_end_byte bigint check (source_end_byte >= source_start_byte),
  add column source_header_bytes integer check (source_header_bytes between 1 and 4096);

-- Retire requests produced by the former full-file coordinator. A running old
-- worker cannot commit an offset, and any stored object remains eligible for
-- the existing failed-download cleanup. Never change manual transfers.
update public.device_commands c
  set status = 'expired', error_message = 'Automatic CSV sync requires incremental firmware'
  from public.download_requests d
  where d.request_kind = 'minute_history'
    and c.payload->>'request_id' = d.id::text
    and c.status in ('queued', 'acknowledged', 'running');
update public.download_requests
  set status = 'failed', error_message = 'Automatic CSV sync requires incremental firmware'
  where request_kind = 'minute_history'
    and status in ('queued', 'device_acknowledged', 'uploading', 'ready');
update public.csv_history_jobs
  set status = 'queued', attempts = 0, retry_at = now(), download_request_id = null,
      start_byte = null, lease_token = null, lease_until = null,
      error_message = null
  where status <> 'completed';

-- The heartbeat version is an explicit rollout gate. Future compatible
-- versions remain eligible; older devices can still perform manual downloads.
create function public.supports_incremental_csv(p_version text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce((v[1]::integer, v[2]::integer, v[3]::integer) >= (1, 2, 5), false)
  from (select regexp_match(p_version,
    '^pm-[a-z0-9-]+-cloud-([0-9]{1,3})[.]([0-9]{1,3})[.]([0-9]{1,3})$') as v) matched;
$$;
revoke all on function public.supports_incremental_csv(text) from public, anon, authenticated;
grant execute on function public.supports_incremental_csv(text) to service_role;

create or replace function public.queue_csv_history() returns void
language plpgsql security definer set search_path = '' as $$
declare
  j record;
  request_id uuid;
  active_count integer;
  start_offset bigint;
  cutoff timestamptz := (date_trunc('day', now() at time zone 'Asia/Kolkata')
    + case when extract(hour from now() at time zone 'Asia/Kolkata') >= 12
      then interval '12 hours' else interval '0 hours' end) at time zone 'Asia/Kolkata';
begin
  if not pg_try_advisory_xact_lock(92625001) then return; end if;
  insert into public.csv_history_settings(device_id) select id from public.devices on conflict do nothing;

  for j in select h.id, h.download_request_id, h.attempts from public.csv_history_jobs h
    left join public.download_requests d on d.id = h.download_request_id
    where (h.status = 'processing' and h.lease_until < now())
       or (h.status = 'waiting' and (d.status in ('failed','expired') or
         (d.status = 'ready' and d.expires_at <= now()) or
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

  insert into public.csv_history_jobs(device_id, filename, hour_end)
    select d.id, d.current_filename, cutoff from public.devices d
    join public.csv_history_settings s on s.device_id = d.id and s.enabled
    where public.supports_incremental_csv(d.firmware_version)
      and d.last_seen > now() - interval '40 minutes'
      and d.current_filename ~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$'
      and (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata') < cutoff
    on conflict do nothing;

  -- A new filename has its own zero offset. Finish the previous weekly file
  -- using its existing offset if it is still on the SD card.
  insert into public.csv_history_jobs(device_id, filename, hour_end)
    select d.id, sync.source_filename,
      (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata')
    from public.devices d join public.csv_history_settings s on s.device_id = d.id and s.enabled
    join public.minute_history_sync sync on sync.device_id = d.id
    where public.supports_incremental_csv(d.firmware_version)
      and d.last_seen > now() - interval '40 minutes' and sync.source_filename <> d.current_filename
      and d.current_filename ~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$'
      and sync.latest_minute >= cutoff - interval '8 days'
    on conflict do nothing;

  update public.csv_history_jobs set status = 'failed', error_message = 'Sync request became too old; the next weekly snapshot will be used.'
    where status = 'queued' and created_at < now() - interval '8 days';
  select count(*) into active_count from public.download_requests where request_kind = 'minute_history'
    and status in ('queued','device_acknowledged','uploading');
  for j in select h.* from public.csv_history_jobs h
    join public.csv_history_settings s on s.device_id = h.device_id and s.enabled
    join public.devices dev on dev.id = h.device_id
      and dev.last_seen > now() - interval '40 minutes'
      and public.supports_incremental_csv(dev.firmware_version)
    where h.status = 'queued' and h.retry_at <= now() and h.attempts < 3
    order by h.created_at, h.hour_end limit 30
  loop
    exit when active_count >= 3;
    if exists(select 1 from public.download_requests where device_id = j.device_id
      and status in ('queued','device_acknowledged','uploading')) then continue; end if;
    if exists(select 1 from public.csv_history_jobs where device_id = j.device_id and status in ('waiting','processing')) then continue; end if;
    select next_byte into start_offset from public.csv_history_offsets
      where device_id = j.device_id and filename = j.filename;
    start_offset := coalesce(start_offset, 0);
    insert into public.download_requests(device_id, filename, created_by, request_kind, source_start_byte)
      values (j.device_id, j.filename, null, 'minute_history', start_offset) returning id into request_id;
    insert into public.device_commands(device_id, command_type, payload)
      values (j.device_id, 'download_file', jsonb_build_object('filename', j.filename,
        'request_id', request_id, 'start_byte', start_offset,
        'hour_end', to_char(j.hour_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'incremental_csv', true));
    update public.csv_history_jobs set status = 'waiting', attempts = attempts + 1,
      download_request_id = request_id, start_byte = start_offset,
      error_message = null where id = j.id;
    active_count := active_count + 1;
  end loop;
end;
$$;

create or replace function public.claim_csv_history_job() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.csv_history_jobs; token uuid := gen_random_uuid();
  d public.download_requests; has_co2 boolean;
begin
  select h.* into j from public.csv_history_jobs h join public.download_requests req on req.id = h.download_request_id
    where h.status = 'waiting' and req.status = 'ready' and req.storage_path is not null
      and req.expires_at > now() and req.source_start_byte = h.start_byte
      and req.source_end_byte is not null and req.source_header_bytes is not null
    order by h.created_at for update of h skip locked limit 1;
  if not found then return null; end if;
  update public.csv_history_jobs set status = 'processing', lease_token = token,
    lease_until = now() + interval '5 minutes' where id = j.id;
  select * into d from public.download_requests where id = j.download_request_id;
  select co2_enabled into has_co2 from public.devices where id = j.device_id;
  return to_jsonb(j) || jsonb_build_object('lease_token', token,
    'storage_path', d.storage_path, 'co2_enabled', has_co2,
    'source_start_byte', d.source_start_byte, 'source_end_byte', d.source_end_byte,
    'source_header_bytes', d.source_header_bytes, 'uploaded_bytes', d.total_bytes);
end;
$$;

-- The former six-argument worker must fail rather than finish an unverified
-- full-file upload during a rolling deployment.
create or replace function public.finish_csv_history_job(p_job uuid, p_token uuid,
  p_latest timestamptz, p_minutes integer, p_skipped integer, p_bytes bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Incremental CSV worker update required';
end;
$$;

create function public.finish_csv_history_job(p_job uuid, p_token uuid,
  p_latest timestamptz, p_minutes integer, p_skipped integer, p_bytes bigint,
  p_header_bytes integer) returns boolean
language plpgsql security definer set search_path = '' as $$
declare j public.csv_history_jobs; d public.download_requests;
  committed bigint; expected_end bigint;
begin
  if p_minutes < 0 or p_skipped < 0 or p_bytes < 1 or p_header_bytes not between 1 and 4096 then
    raise exception 'Invalid incremental import result';
  end if;
  select * into j from public.csv_history_jobs
    where id = p_job and lease_token = p_token and status = 'processing' for update;
  if not found then return false; end if;
  select * into d from public.download_requests where id = j.download_request_id for update;
  if d.request_kind <> 'minute_history' or d.status <> 'ready' or
     d.source_start_byte is null or d.source_end_byte is null or
     d.source_header_bytes is null or d.total_bytes is null or
     d.source_start_byte <> j.start_byte or d.source_header_bytes <> p_header_bytes or
     d.total_bytes <> p_bytes then
    raise exception 'Incremental transfer metadata changed';
  end if;
  select next_byte into committed from public.csv_history_offsets
    where device_id = j.device_id and filename = j.filename for update;
  if coalesce(committed, 0) <> j.start_byte then
    raise exception 'Incremental transfer offset changed';
  end if;
  expected_end := case when j.start_byte = 0 then p_bytes
    else j.start_byte + p_bytes - p_header_bytes end;
  if d.source_end_byte <> expected_end or expected_end < j.start_byte or
     (p_latest is not null and p_latest >= j.hour_end) or
     (p_minutes > 0 and p_latest is null) then
    raise exception 'Incremental transfer boundary mismatch';
  end if;
  insert into public.csv_history_offsets(device_id, filename, next_byte)
    values (j.device_id, j.filename, expected_end)
    on conflict (device_id, filename) do update
      set next_byte = excluded.next_byte, updated_at = now();
  update public.csv_history_jobs set status = 'completed', completed_at = now(),
    imported_minutes = p_minutes, skipped_rows = p_skipped, source_bytes = p_bytes,
    lease_until = null where id = j.id;
  if p_latest is not null and p_minutes > 0 then
    insert into public.minute_history_sync(device_id, latest_minute, source_filename, imported_minutes)
      values (j.device_id, p_latest, j.filename, p_minutes)
    on conflict (device_id) do update set last_imported_at = now(),
      latest_minute = greatest(public.minute_history_sync.latest_minute, excluded.latest_minute),
      source_filename = case when excluded.latest_minute >= public.minute_history_sync.latest_minute
        then excluded.source_filename else public.minute_history_sync.source_filename end,
      imported_minutes = excluded.imported_minutes;
  end if;
  return true;
end;
$$;
revoke all on function public.finish_csv_history_job(uuid, uuid, timestamptz, integer, integer, bigint, integer)
  from public, anon, authenticated;
grant execute on function public.finish_csv_history_job(uuid, uuid, timestamptz, integer, integer, bigint, integer)
  to service_role;

-- A named cron.schedule call replaces the former every-minute job in place.
select cron.schedule('csv-minute-history-coordinator', '*/15 * * * *',
  'select public.tick_csv_history();');

commit;
