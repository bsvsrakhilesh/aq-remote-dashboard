begin;

create table public.telemetry_1min (
  device_id uuid not null references public.devices(id) on delete cascade,
  timestamp timestamptz not null check (extract(epoch from timestamp)::bigint % 60 = 0),
  pm1 real check (pm1 between 0 and 10000),
  pm25 real check (pm25 between 0 and 10000),
  pm10 real check (pm10 between 0 and 10000),
  temperature_c real check (temperature_c between -80 and 100),
  rh real check (rh between 0 and 100),
  co2_ppm real check (co2_ppm > 0 and co2_ppm <= 1000000),
  sample_count smallint not null check (sample_count between 1 and 60),
  valid_counts smallint[] not null check (array_length(valid_counts, 1) = 6),
  received_at timestamptz not null default now(),
  primary key (device_id, timestamp)
);

create table public.minute_history_sync (
  device_id uuid primary key references public.devices(id) on delete cascade,
  last_imported_at timestamptz not null default now(),
  latest_minute timestamptz not null,
  source_filename text not null,
  imported_minutes integer not null check (imported_minutes > 0)
);

alter table public.telemetry_1min enable row level security;
alter table public.minute_history_sync enable row level security;
revoke all on public.telemetry_1min, public.minute_history_sync from anon, authenticated;
grant select on public.telemetry_1min, public.minute_history_sync to anon, authenticated;
grant all on public.telemetry_1min, public.minute_history_sync to service_role;
create policy "authenticated reads minute history" on public.telemetry_1min for select to authenticated using (true);
create policy "authenticated reads minute sync" on public.minute_history_sync for select to authenticated using (true);
create policy "public reads minute history when enabled" on public.telemetry_1min for select to anon
  using ((select public_read_only from public.dashboard_settings where id = true));
create policy "public reads minute sync when enabled" on public.minute_history_sync for select to anon
  using ((select public_read_only from public.dashboard_settings where id = true));

-- Used only by the CSV processing worker. Overlapping snapshots and retries
-- cannot duplicate points or replace a fuller minute with fewer source rows.
create function public.ingest_minute_history(p_device_id uuid, p_rows jsonb)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 500 then
    raise exception 'Expected 1-500 minute records';
  end if;
  insert into public.telemetry_1min
    (device_id, timestamp, pm1, pm25, pm10, temperature_c, rh, co2_ppm, sample_count, valid_counts)
  select p_device_id, r.timestamp, r.pm1, r.pm25, r.pm10, r.temperature, r.rh, r.co2, r.sample_count, r.valid_counts
  from jsonb_to_recordset(p_rows) as r(timestamp timestamptz, pm1 real, pm25 real, pm10 real,
    temperature real, rh real, co2 real, sample_count smallint, valid_counts smallint[])
  on conflict (device_id, timestamp) do update set
    pm1 = excluded.pm1, pm25 = excluded.pm25, pm10 = excluded.pm10,
    temperature_c = excluded.temperature_c, rh = excluded.rh, co2_ppm = excluded.co2_ppm,
    sample_count = excluded.sample_count, valid_counts = excluded.valid_counts, received_at = now()
  where excluded.sample_count > public.telemetry_1min.sample_count;

end;
$$;
revoke all on function public.ingest_minute_history(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_minute_history(uuid, jsonb) to service_role;

comment on table public.telemetry_1min is 'Arithmetic means of valid CSV rows per minute, imported from scheduled SD-file downloads. CSV clocks are IST; timestamps stored in UTC. No interpolation.';

alter table public.download_requests add column request_kind text not null default 'manual'
  check (request_kind in ('manual', 'minute_history'));
alter table public.download_requests alter column created_by drop not null;
alter table public.download_requests add constraint automatic_download_owner
  check (created_by is not null or request_kind = 'minute_history');
drop policy "users create own downloads" on public.download_requests;
create policy "users create own downloads" on public.download_requests for insert to authenticated
  with check (created_by = auth.uid() and request_kind = 'manual');

create table public.csv_history_settings (
  device_id uuid primary key references public.devices(id) on delete cascade,
  enabled boolean not null default true
);
create table public.csv_history_jobs (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.devices(id) on delete cascade,
  filename text not null,
  hour_end timestamptz not null,
  status text not null default 'queued' check (status in ('queued','waiting','processing','completed','failed')),
  download_request_id uuid references public.download_requests(id),
  attempts integer not null default 0,
  retry_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  error_message text,
  imported_minutes integer,
  skipped_rows integer,
  source_bytes bigint,
  unique (device_id, filename, hour_end)
);
create index csv_history_jobs_queue on public.csv_history_jobs(status, retry_at, created_at);
create index csv_history_jobs_device on public.csv_history_jobs(device_id, created_at desc);
alter table public.csv_history_settings enable row level security;
alter table public.csv_history_jobs enable row level security;
revoke all on public.csv_history_settings, public.csv_history_jobs from anon, authenticated;
grant select on public.csv_history_settings, public.csv_history_jobs to anon, authenticated;
grant update(enabled) on public.csv_history_settings to authenticated;
grant all on public.csv_history_settings, public.csv_history_jobs to service_role;
create policy "users read history settings" on public.csv_history_settings for select to authenticated using (true);
create policy "users control hourly history" on public.csv_history_settings for update to authenticated using (true) with check (true);
create policy "users read history jobs" on public.csv_history_jobs for select to authenticated using (true);
create policy "public reads history settings when enabled" on public.csv_history_settings for select to anon
  using ((select public_read_only from public.dashboard_settings where id = true));
create policy "public reads history jobs when enabled" on public.csv_history_jobs for select to anon
  using ((select public_read_only from public.dashboard_settings where id = true));
insert into public.csv_history_settings(device_id) select id from public.devices;

-- One transaction creates each automatic request and its existing firmware command.
-- Serializes scheduler runs, gives manual transfers priority, and bounds concurrency.
create function public.queue_csv_history() returns void language plpgsql security definer set search_path = '' as $$
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
         (d.status <> 'ready' and d.created_at < now() - interval '25 minutes')))
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
    where d.last_seen > now() - interval '10 minutes'
      and d.current_filename ~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$'
      and (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata') < cutoff
    on conflict do nothing;

  -- At weekly rollover, take one final snapshot of the previously synced file.
  insert into public.csv_history_jobs(device_id, filename, hour_end)
    select d.id, sync.source_filename,
      (substring(d.current_filename from '_([0-9]{4}-[0-9]{2}-[0-9]{2})_to_')::date::timestamp at time zone 'Asia/Kolkata')
    from public.devices d join public.csv_history_settings s on s.device_id = d.id and s.enabled
    join public.minute_history_sync sync on sync.device_id = d.id
    where d.last_seen > now() - interval '10 minutes' and sync.source_filename <> d.current_filename
      and d.current_filename ~ '^[a-zA-Z0-9_-]+_[0-9]{4}-[0-9]{2}-[0-9]{2}_to_[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$'
      and sync.latest_minute >= cutoff - interval '8 days'
    on conflict do nothing;

  update public.csv_history_jobs set status = 'failed', error_message = 'Sync request became too old; the next weekly snapshot will be used.'
    where status = 'queued' and created_at < now() - interval '8 days';
  select count(*) into active_count from public.download_requests where request_kind = 'minute_history'
    and status in ('queued','device_acknowledged','uploading');
  for j in select h.* from public.csv_history_jobs h
    join public.csv_history_settings s on s.device_id = h.device_id and s.enabled
    join public.devices dev on dev.id = h.device_id and dev.last_seen > now() - interval '10 minutes'
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
revoke all on function public.queue_csv_history() from public, anon, authenticated;
grant execute on function public.queue_csv_history() to service_role;

create function public.claim_csv_history_job() returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.csv_history_jobs; token uuid := gen_random_uuid(); path text; has_co2 boolean;
begin
  select h.* into j from public.csv_history_jobs h join public.download_requests d on d.id = h.download_request_id
    where h.status = 'waiting' and d.status = 'ready' and d.storage_path is not null and d.expires_at > now()
    order by h.created_at for update of h skip locked limit 1;
  if not found then return null; end if;
  update public.csv_history_jobs set status = 'processing', lease_token = token, lease_until = now() + interval '5 minutes' where id = j.id;
  select storage_path into path from public.download_requests where id = j.download_request_id;
  select co2_enabled into has_co2 from public.devices where id = j.device_id;
  return to_jsonb(j) || jsonb_build_object('lease_token', token, 'storage_path', path, 'co2_enabled', has_co2);
end;
$$;
revoke all on function public.claim_csv_history_job() from public, anon, authenticated;
grant execute on function public.claim_csv_history_job() to service_role;

create function public.finish_csv_history_job(p_job uuid, p_token uuid, p_latest timestamptz,
  p_minutes integer, p_skipped integer, p_bytes bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare j public.csv_history_jobs;
begin
  update public.csv_history_jobs set status = 'completed', completed_at = now(), imported_minutes = p_minutes,
    skipped_rows = p_skipped, source_bytes = p_bytes, lease_until = null
    where id = p_job and lease_token = p_token and status = 'processing' returning * into j;
  if not found then return false; end if;
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
revoke all on function public.finish_csv_history_job(uuid, uuid, timestamptz, integer, integer, bigint) from public, anon, authenticated;
grant execute on function public.finish_csv_history_job(uuid, uuid, timestamptz, integer, integer, bigint) to service_role;

-- The cron token stays in Vault, never in frontend code or firmware.
create extension if not exists supabase_vault with schema vault;
do $$ begin
  if not exists(select 1 from vault.secrets where name = 'csv_history_worker_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'csv_history_worker_secret');
  end if;
end $$;
create function public.authorize_csv_history_worker(p_secret text) returns boolean
language sql security definer set search_path = '' as $$
  select p_secret is not null and exists(select 1 from vault.decrypted_secrets where name = 'csv_history_worker_secret'
    and extensions.digest(decrypted_secret, 'sha256') = extensions.digest(p_secret, 'sha256'));
$$;
revoke all on function public.authorize_csv_history_worker(text) from public, anon, authenticated;
grant execute on function public.authorize_csv_history_worker(text) to service_role;
commit;
