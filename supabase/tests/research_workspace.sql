-- Run with: npx.cmd supabase db query --linked --file supabase/tests/research_workspace.sql
-- The fixture is transaction-local; all records are rolled back.
begin;
do $$
declare fixture uuid; actor uuid; fixture_rule_id uuid; event_id uuid; run_id uuid;
        result record; next_index integer; count_points integer; prior_monday date;
begin
  select id into actor from auth.users limit 1;
  if actor is null then raise exception 'A research user is required for this test'; end if;
  insert into public.devices(device_code,display_name,last_seen,secret_hash)
    values('test_research_fixture','Rollback-only research fixture',now()-interval '25 minutes','no-device-key')
    returning id into fixture;
  insert into public.telemetry_5min(device_id,timestamp,pm1,pm25,pm10,temperature_c,rh)
    values(fixture,date_trunc('hour',now())-interval '1 hour',10,20,30,25,50);
  select * into result from public.research_series(array[fixture],now()-interval '2 hours',now(),'snapshot');
  if result.points<>1 or result.pm25<>20 or result.valid_counts[2]<>1 then
    raise exception 'Research series aggregation failed'; end if;
  insert into public.alert_rules(device_id,metric,threshold,duration_minutes,created_by)
    values(fixture,'offline',0,15,actor) returning id into fixture_rule_id;
  perform public.evaluate_research_alerts();
  select id into event_id from public.alert_events where rule_id=fixture_rule_id and resolved_at is null;
  if event_id is null then raise exception 'Offline alert did not open'; end if;
  update public.devices set last_seen=now() where id=fixture;
  perform public.evaluate_research_alerts();
  if exists(select 1 from public.alert_events where id=event_id and resolved_at is null) then
    raise exception 'Offline alert did not resolve'; end if;
  insert into public.csv_import_runs(device_id,filename,created_by,expected_bytes)
    values(fixture,'test_research_fixture_2026-09-21_to_2026-09-27.csv',actor,20) returning id into run_id;
  next_index:=public.record_csv_import_chunk(run_id,0,3,1,10);
  if next_index<>1 or public.record_csv_import_chunk(run_id,0,3,1,10)<>1 then
    raise exception 'Chunk retry was not idempotent'; end if;
  select imported_minutes into count_points from public.csv_import_runs where id=run_id;
  if count_points<>3 then raise exception 'Retried chunk doubled import counters'; end if;
  insert into public.telemetry_1min(device_id,timestamp,pm1,sample_count,valid_counts)
    values(fixture,'2020-01-01T00:00:00Z',10,1,array[1,0,0,0,0,0]::smallint[]);
  if exists(select 1 from public.history_retention where device_id=fixture) then
    raise exception 'Retention must be off by default'; end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if public.preview_history_retention(fixture,7)<>1 then raise exception 'Retention preview miscounted'; end if;
  begin
    perform public.set_history_retention(fixture,7,false);
    raise exception 'Retention accepted without confirmation';
  exception when others then
    if sqlerrm='Retention accepted without confirmation' then raise; end if;
  end;
  perform public.set_history_retention(fixture,7,true);
  if not exists(select 1 from public.history_retention where device_id=fixture and days=7) then
    raise exception 'Confirmed retention was not saved'; end if;
  prior_monday:=date_trunc('week',now() at time zone 'Asia/Kolkata')::date-7;
  update public.devices set current_filename='test_research_fixture_'||to_char(prior_monday,'YYYY-MM-DD')||
    '_to_'||to_char(prior_monday+6,'YYYY-MM-DD')||'.csv' where id=fixture;
  perform public.request_history_sync(fixture);
  if not exists(select 1 from public.csv_history_jobs where device_id=fixture and status='queued') then
    raise exception 'Manual CSV refresh was not queued'; end if;
  if not exists(select 1 from public.csv_history_settings where device_id=fixture and last_manual_at is not null) then
    raise exception 'Manual CSV refresh did not set a rate limit'; end if;
  begin
    perform public.request_history_sync(fixture);
    raise exception 'Manual CSV refresh accepted too soon';
  exception when others then
    if sqlerrm='Manual CSV refresh accepted too soon' then raise; end if;
  end;
  if has_function_privilege('anon','public.request_history_sync(uuid)','execute')
    or has_function_privilege('anon','public.set_history_retention(uuid,integer,boolean)','execute')
    or has_function_privilege('authenticated','public.record_csv_import_chunk(uuid,integer,integer,integer,bigint)','execute')
    or has_table_privilege('anon','public.csv_import_runs','select') then
    raise exception 'Research permission boundary failed'; end if;
  raise notice 'Research aggregation, alert lifecycle, chunk retry, retention, manual sync and permissions passed';
end $$;
rollback;
