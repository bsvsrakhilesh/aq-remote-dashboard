begin;
alter table public.csv_import_runs add column next_chunk integer not null default 0 check(next_chunk>=0);
alter table public.csv_import_runs add column expected_bytes bigint check(expected_bytes between 1 and 104857600);

-- Called after each idempotent minute upsert. A repeated chunk can safely be
-- retried when an HTTP response is lost without inflating import counters.
create function public.record_csv_import_chunk(p_run uuid,p_index integer,p_minutes integer,p_skipped integer,p_bytes bigint)
returns integer language plpgsql security invoker set search_path='' as $$
declare updated_index integer;
begin
 if p_index<0 or p_minutes<0 or p_skipped<0 or p_bytes<1 or p_bytes>3145728 then
  raise exception 'Invalid import chunk';
 end if;
 update public.csv_import_runs set next_chunk=next_chunk+1,
   imported_minutes=imported_minutes+p_minutes,skipped_rows=skipped_rows+p_skipped,
   source_bytes=source_bytes+p_bytes
 where id=p_run and status='processing' and next_chunk=p_index
 returning next_chunk into updated_index;
 if updated_index is not null then return updated_index; end if;
 select next_chunk into updated_index from public.csv_import_runs where id=p_run and status='processing';
 if updated_index>p_index then return updated_index; end if;
 raise exception 'Import chunk arrived out of order or run is closed';
end $$;
revoke all on function public.record_csv_import_chunk(uuid,integer,integer,integer,bigint) from public,anon,authenticated;
grant execute on function public.record_csv_import_chunk(uuid,integer,integer,integer,bigint) to service_role;

-- Large SD files can take several minutes over a browser connection.
select cron.schedule('expire-stale-csv-imports','*/10 * * * *',
 $$update public.csv_import_runs set status='failed',error_message='Import interrupted. Retry the same file safely.' where status='processing' and created_at<now()-interval '2 hours';$$);
commit;
