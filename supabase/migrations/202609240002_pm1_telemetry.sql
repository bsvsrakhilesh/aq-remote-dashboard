alter table public.telemetry_5min
  add column if not exists pm1 real check (pm1 is null or pm1 between 0 and 10000);

comment on column public.telemetry_5min.pm1 is
  'Measured PM1 mass concentration in micrograms per cubic meter. NULL means not reported or unavailable.';
