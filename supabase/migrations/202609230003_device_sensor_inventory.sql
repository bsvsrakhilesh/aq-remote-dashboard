begin;
alter table public.devices add column installed_sensors text[] not null default array['sps30','sht3x'];
comment on column public.devices.installed_sensors is 'Installed sensor models, independent of health. Provision per logger; an absent sensor is not a fault.';
update public.devices set installed_sensors = array['sps30','sht3x','scd30'] where co2_enabled;
update public.devices set installed_sensors = array['sps30','scd30'] where device_code = 'aq_indoor01';
grant select (installed_sensors) on public.devices to authenticated, anon;
commit;
