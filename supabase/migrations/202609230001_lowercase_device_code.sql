-- Device IDs are case-sensitive and may contain uppercase or lowercase letters.
-- Preserve the device UUID so telemetry, commands, and downloads stay linked.
begin;

alter table public.devices
  drop constraint devices_device_code_check;

alter table public.devices
  add constraint devices_device_code_check
  check (device_code ~ '^[A-Za-z0-9_-]{2,32}$');

update public.devices
set device_code = 'aq_indoor01'
where device_code = 'AQ01';

commit;
