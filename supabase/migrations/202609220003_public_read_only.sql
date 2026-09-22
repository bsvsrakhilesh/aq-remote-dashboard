create table public.dashboard_settings (
  id boolean primary key default true check (id),
  public_read_only boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into public.dashboard_settings (id, public_read_only) values (true, false) on conflict (id) do nothing;
alter table public.dashboard_settings enable row level security;

create policy "everyone reads dashboard mode"
on public.dashboard_settings for select
to anon, authenticated
using (id = true);

create policy "anonymous reads devices when public mode enabled"
on public.devices for select
to anon
using ((select public_read_only from public.dashboard_settings where id = true));

create policy "anonymous reads telemetry when public mode enabled"
on public.telemetry_5min for select
to anon
using ((select public_read_only from public.dashboard_settings where id = true));

comment on table public.dashboard_settings is 'Server-side gate for anonymous dashboard reads. Change only through trusted SQL/service-role operations.';
