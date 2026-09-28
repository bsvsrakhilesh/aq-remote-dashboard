-- Run with: npx.cmd supabase db query --linked --file supabase/tests/fleet_reliability.sql
-- All fixture data is rolled back.
begin;
do $$
declare fixture uuid; start_at timestamptz; result record;
begin
  start_at := (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') - interval '7 days';
  insert into public.devices(device_code, display_name, secret_hash, created_at)
    values ('test_fleet_reliability', 'Rollback-only reliability fixture', 'no-device-key', start_at)
    returning id into fixture;
  insert into public.telemetry_5min(device_id, "timestamp", pm25) values
    (fixture, start_at + interval '1 day', 10),
    (fixture, start_at + interval '1 day 5 minutes', 11);
  insert into public.telemetry_1min(device_id, "timestamp", pm25, sample_count, valid_counts)
    values (fixture, start_at + interval '1 day', 10, 1, array[0,1,0,0,0,0]::smallint[]);
  insert into public.csv_history_jobs(device_id, filename, hour_end, status, created_at) values
    (fixture, 'test_fleet_reliability_2026-09-14_to_2026-09-20.csv', start_at + interval '1 day', 'failed', start_at + interval '1 day'),
    (fixture, 'test_fleet_reliability_2026-09-21_to_2026-09-27.csv', start_at + interval '2 days', 'completed', start_at + interval '2 days');

  select * into result from public.fleet_reliability(7) where device_id = fixture;
  if result.expected_snapshots <> 2016 or result.reported_snapshots <> 2
    or result.expected_minutes <> 10080 or result.recorded_minutes <> 1
    or result.failed_syncs <> 1 or result.completed_syncs <> 1 or result.latest_failure_at is null then
    raise exception 'Fleet reliability aggregation failed: %', row_to_json(result);
  end if;
  insert into public.history_retention(device_id, days) values (fixture, 7);
  select * into result from public.fleet_reliability(30) where device_id = fixture;
  if result.retention_days <> 7 or result.expected_snapshots <> 2016
    or result.expected_minutes >= 10080 or result.expected_minutes < 8000 then
    raise exception 'Configured retention was not applied to CSV coverage';
  end if;
  begin
    perform public.fleet_reliability(14);
    raise exception 'Unsupported period was accepted';
  exception when others then
    if sqlerrm = 'Unsupported period was accepted' then raise; end if;
  end;
  if not has_function_privilege('authenticated', 'public.fleet_reliability(integer)', 'execute') then
    raise exception 'Researcher cannot read fleet reliability';
  end if;
  if has_function_privilege('anon', 'public.fleet_reliability(integer)', 'execute') then
    raise exception 'Public role can read operational reliability';
  end if;
  raise notice 'Fleet reliability period, coverage, retention, job counts and privilege passed';
end $$;
set local role authenticated;
do $$
begin
  if not exists (select 1 from public.fleet_reliability(7) r
    join public.devices d on d.id = r.device_id where d.device_code = 'test_fleet_reliability') then
    raise exception 'Authenticated caller could not read reliability through RLS';
  end if;
end $$;
rollback;
