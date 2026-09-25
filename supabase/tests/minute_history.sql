-- Run with: npx.cmd supabase db query --linked --file supabase/tests/minute_history.sql
-- All fixture changes are rolled back; no telemetry or device records are retained.
begin;
do $$
declare device uuid; first_sample jsonb; stored_count integer; stored_pm1 real;
begin
  select id into device from public.devices limit 1;
  if device is null then raise exception 'Test requires one registered device'; end if;
  first_sample := jsonb_build_array(jsonb_build_object('timestamp','2020-01-01T00:00:00Z',
    'pm1',15,'pm25',20,'pm10',null,'temperature',26,'rh',50,'co2',null,
    'sample_count',2,'valid_counts',jsonb_build_array(2,1,0,2,1,0)));
  perform public.ingest_minute_history(device, first_sample);
  perform public.ingest_minute_history(device, first_sample);
  perform public.ingest_minute_history(device, jsonb_set(jsonb_set(first_sample,
    '{0,sample_count}','1'),'{0,pm1}','999'));
  select sample_count,pm1 into stored_count,stored_pm1 from public.telemetry_1min
    where device_id=device and timestamp='2020-01-01T00:00:00Z';
  if stored_count <> 2 or stored_pm1 <> 15 then raise exception 'Idempotency failed'; end if;
  perform public.ingest_minute_history(device, jsonb_set(jsonb_set(first_sample,
    '{0,sample_count}','3'),'{0,pm1}','25'));
  select sample_count,pm1 into stored_count,stored_pm1 from public.telemetry_1min
    where device_id=device and timestamp='2020-01-01T00:00:00Z';
  if stored_count <> 3 or stored_pm1 <> 25 then raise exception 'Fuller minute update failed'; end if;
  if has_function_privilege('anon','public.ingest_minute_history(uuid,jsonb)','execute')
    or has_function_privilege('authenticated','public.authorize_csv_history_worker(text)','execute')
    or has_function_privilege('anon','public.tick_csv_history()','execute')
    or has_table_privilege('authenticated','public.telemetry_1min','insert') then
    raise exception 'History permission boundary failed';
  end if;
  raise notice 'Minute upserts, retry idempotency, and permission checks passed';
end $$;
rollback;
