begin;
create table public.csv_import_runs (
 id uuid primary key default gen_random_uuid(),device_id uuid not null references public.devices(id) on delete cascade,
 filename text not null,created_by uuid not null references auth.users(id),created_at timestamptz not null default now(),
 completed_at timestamptz,status text not null default 'processing' check(status in ('processing','completed','failed')),
 imported_minutes integer not null default 0,skipped_rows integer not null default 0,source_bytes bigint not null default 0,
 error_message text
);
alter table public.csv_import_runs enable row level security;
revoke all on public.csv_import_runs from anon,authenticated;
grant select on public.csv_import_runs to authenticated;
grant all on public.csv_import_runs to service_role;
create policy "researchers read imports" on public.csv_import_runs for select to authenticated using(true);
create index csv_import_device on public.csv_import_runs(device_id,created_at desc);
-- Stale browser uploads must not leave an import marked active forever.
select cron.schedule('expire-stale-csv-imports','*/10 * * * *',
 $$update public.csv_import_runs set status='failed',error_message='Import interrupted. Retry the same file safely.' where status='processing' and created_at<now()-interval '10 minutes';$$);
commit;
