-- Run against a disposable migrated local database. All fixtures are rolled back.
begin;
do $$
declare
  owner uuid := gen_random_uuid();
  device uuid := gen_random_uuid();
  csv_file uuid := gen_random_uuid();
  ready_request uuid := gen_random_uuid();
  result jsonb;
  claim jsonb;
  minute_id uuid;
  raw_id uuid;
  contents text;
  checksum text;
begin
  insert into auth.users(id) values (owner);
  insert into public.devices(id, device_code, secret_hash) values (device, 'AXIOMSQLTEST', 'fixture-only');
  insert into public.device_files(id, device_id, filename, size_bytes) values (csv_file, device, 'sample.csv', 3500);
  insert into public.telemetry_1min(device_id, timestamp, pm25, sample_count, valid_counts)
    values (device, '2020-01-01T00:00:00Z', 12.5, 1, array[0,1,0,0,0,0]::smallint[]);

  if has_function_privilege('authenticated', 'public.claim_axiom_job(uuid)', 'execute')
    or has_function_privilege('service_role', 'public.prune_backed_up_axiom_minutes(uuid,text)', 'execute')
    or has_table_privilege('authenticated', 'public.axiom_jobs', 'select') then
    raise exception 'Axiom permissions are too broad';
  end if;

  result := public.create_axiom_job(owner, device, 'minute', null, '2020-01-01', '2020-01-01', true);
  if result <> '{"rows":1,"expected":1440}'::jsonb then raise exception 'Incorrect IST coverage: %', result; end if;
  result := public.create_axiom_job(owner, device, 'minute', null, '2020-01-01', '2020-01-01', false);
  minute_id := (result->>'id')::uuid;
  if minute_id is null or public.create_axiom_job(owner, device, 'minute', null,
      '2020-01-01', '2020-01-01', false)->>'id' <> minute_id::text then
    raise exception 'Minute queue deduplication failed';
  end if;
  claim := public.claim_axiom_job(owner);
  if claim->>'id' is distinct from minute_id::text or public.claim_axiom_job(owner) is not null then
    raise exception 'Lease allowed a concurrent claim';
  end if;
  select payload into contents from public.axiom_jobs where id = minute_id;
  if strpos(contents, '2020-01-01T00:00:00Z,2020-01-01T05:30:00+05:30,,12.5,') = 0 then
    raise exception 'Timestamp or sparse values did not round trip';
  end if;
  checksum := encode(sha256(convert_to(contents, 'UTF8')), 'hex');
  if public.finish_axiom_job(owner, minute_id, gen_random_uuid(), checksum, null, false) then
    raise exception 'An invalid lease acknowledged the transfer';
  end if;
  if public.recover_axiom_job(owner, minute_id, checksum) <> 'ready' then
    raise exception 'Lost acknowledgement was not recovered';
  end if;
  update public.telemetry_1min set pm25 = 19 where device_id = device and timestamp = '2020-01-01T00:00:00Z';
  begin
    perform public.prune_backed_up_axiom_minutes(minute_id, checksum);
    raise exception 'Cloud correction was deleted';
  exception when raise_exception then
    if sqlerrm <> 'Cloud rows changed since the backup; archive the date range again' then raise; end if;
  end;
  update public.telemetry_1min set pm25 = 12.5 where device_id = device and timestamp = '2020-01-01T00:00:00Z';
  if public.prune_backed_up_axiom_minutes(minute_id, checksum) <> 1 then
    raise exception 'Verified unchanged snapshot was not pruned';
  end if;

  insert into public.download_requests(id, device_id, filename, created_by, status, total_bytes, expires_at, storage_path)
    values (ready_request, device, 'sample.csv', owner, 'ready', 3500, now() + interval '10 minutes', 'test/sample.csv');
  update public.axiom_worker_status set paused = true where owner_id = owner;
  if public.create_axiom_job(owner, device, 'raw', csv_file, null, null, false)->>'error' is distinct from 'paused' then
    raise exception 'User pause did not block enqueue';
  end if;
  update public.axiom_worker_status set paused = false where owner_id = owner;
  raw_id := (public.create_axiom_job(owner, device, 'raw', csv_file, null, null, false)->>'id')::uuid;
  claim := public.claim_axiom_job(owner);
  if claim->>'id' is distinct from raw_id::text or claim->>'storage_path' is distinct from 'test/sample.csv' then
    raise exception 'An eligible manual snapshot was not reused';
  end if;
  if not public.finish_axiom_job(owner, raw_id, (claim->>'lease')::uuid, checksum, null, false) then
    raise exception 'Could not acknowledge the raw snapshot';
  end if;
  if not exists (select 1 from public.download_requests where id = ready_request and expires_at > now()) then
    raise exception 'Reused manual snapshot was expired';
  end if;

  raw_id := (public.create_axiom_job(owner, device, 'raw', csv_file, null, null, false)->>'id')::uuid;
  update public.download_requests set expires_at = now() where id = ready_request;
  claim := public.claim_axiom_job(owner);
  if claim is not null or not exists (
    select 1 from public.axiom_jobs j join public.download_requests d on d.id = j.request_id
    where j.id = raw_id and j.status = 'waiting_logger' and d.request_kind = 'axiom'
  ) then raise exception 'A missing ready snapshot did not queue a logger command'; end if;
  update public.download_requests set status = 'ready', total_bytes = 3500, storage_path = 'next/sample.csv',
    expires_at = now() + interval '15 minutes' where id = (select request_id from public.axiom_jobs where id = raw_id);
  update public.axiom_usage set reserved_bytes = 1073741824;
  claim := public.claim_axiom_job(owner);
  if claim is not null or not exists (
    select 1 from public.axiom_jobs where id = raw_id and error_code = 'budget'
  ) then raise exception 'Monthly transfer limit was bypassed'; end if;
end;
$$;
rollback;
