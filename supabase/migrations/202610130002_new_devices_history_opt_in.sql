begin;

-- Automatic one-minute CSV history consumes Storage egress and database space.
-- Keep existing devices' choices; additional loggers start paused so growing
-- the fleet does not silently turn on high-volume transfers.
alter table public.csv_history_settings alter column enabled set default false;
comment on column public.csv_history_settings.enabled is
  'Existing settings are preserved. New devices opt in to automatic one-minute CSV history.';

commit;
