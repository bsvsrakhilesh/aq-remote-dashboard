create extension if not exists pgcrypto;

create type public.command_status as enum ('queued','acknowledged','running','completed','failed','expired');
create type public.download_status as enum ('queued','device_acknowledged','uploading','ready','failed','expired');

create table public.devices (
  id uuid primary key default gen_random_uuid(), device_code text unique not null check (device_code ~ '^[A-Z0-9_-]{2,32}$'), display_name text,
  description text, firmware_version text, last_seen timestamptz, wifi_rssi integer check (wifi_rssi between -120 and 0), ip_address inet,
  sd_ok boolean, sps30_ok boolean, sht3x_ok boolean, rtc_ok boolean, current_filename text, current_file_size bigint check (current_file_size >= 0),
  secret_hash text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.telemetry_5min (
  id bigint generated always as identity primary key, device_id uuid not null references public.devices(id) on delete cascade, timestamp timestamptz not null,
  pm25 real check (pm25 is null or pm25 between 0 and 10000), pm10 real check (pm10 is null or pm10 between 0 and 10000),
  temperature_c real check (temperature_c is null or temperature_c between -80 and 100), rh real check (rh is null or rh between 0 and 100), created_at timestamptz not null default now(),
  unique(device_id,timestamp)
);
create index telemetry_device_timestamp_idx on public.telemetry_5min(device_id,timestamp desc);
create table public.device_files (
  id uuid primary key default gen_random_uuid(), device_id uuid not null references public.devices(id) on delete cascade, filename text not null,
  size_bytes bigint not null check (size_bytes >= 0), modified_at timestamptz, last_scanned_at timestamptz not null default now(), unique(device_id,filename)
);
create table public.device_commands (
  id uuid primary key default gen_random_uuid(), device_id uuid not null references public.devices(id) on delete cascade,
  command_type text not null check (command_type in ('list_files','download_file')), payload jsonb not null default '{}',
  status public.command_status not null default 'queued', created_at timestamptz not null default now(), acknowledged_at timestamptz, completed_at timestamptz, error_message text
);
create index command_poll_idx on public.device_commands(device_id,status,created_at);
create table public.download_requests (
  id uuid primary key default gen_random_uuid(), device_id uuid not null references public.devices(id) on delete cascade, filename text not null,
  status public.download_status not null default 'queued', progress_percent integer not null default 0 check (progress_percent between 0 and 100),
  bytes_uploaded bigint not null default 0, total_bytes bigint, storage_path text, created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(), started_at timestamptz, completed_at timestamptz, expires_at timestamptz, error_message text
);
create index download_device_status_idx on public.download_requests(device_id,status,created_at desc);

alter table public.devices enable row level security;
alter table public.telemetry_5min enable row level security;
alter table public.device_files enable row level security;
alter table public.device_commands enable row level security;
alter table public.download_requests enable row level security;
create policy "authenticated users read devices" on public.devices for select to authenticated using (true);
create policy "authenticated users read telemetry" on public.telemetry_5min for select to authenticated using (true);
create policy "authenticated users read files" on public.device_files for select to authenticated using (true);
create policy "users read own downloads" on public.download_requests for select to authenticated using (created_by = auth.uid());
create policy "users create own downloads" on public.download_requests for insert to authenticated with check (created_by = auth.uid());
create policy "users read requested commands" on public.device_commands for select to authenticated using (exists(select 1 from public.download_requests d where d.device_id=device_commands.device_id and d.created_by=auth.uid()));

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types) values ('temporary-downloads','temporary-downloads',false,104857600,array['text/csv','application/csv','text/plain']) on conflict (id) do nothing;
create policy "owners download temporary objects" on storage.objects for select to authenticated using (bucket_id='temporary-downloads' and exists(select 1 from public.download_requests d where d.storage_path=name and d.created_by=auth.uid() and d.expires_at > now()));

create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
create trigger devices_updated before update on public.devices for each row execute function public.touch_updated_at();
