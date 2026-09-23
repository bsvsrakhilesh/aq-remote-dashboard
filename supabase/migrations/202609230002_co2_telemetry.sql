begin;

alter table public.devices
  add column co2_enabled boolean not null default false,
  add column scd30_ok boolean;

alter table public.telemetry_5min
  add column co2_ppm real check (co2_ppm is null or (co2_ppm > 0 and co2_ppm <= 1000000));

comment on column public.telemetry_5min.co2_ppm is
  'Measured CO2 concentration in ppm. NULL means unavailable; never inferred from other sensors.';
comment on column public.devices.scd30_ok is
  'Optional SCD30 health from device heartbeat. NULL means not yet reported.';

grant select (co2_enabled, scd30_ok) on public.devices to authenticated, anon;

update public.devices set co2_enabled = true where device_code = 'aq_indoor01';

commit;
