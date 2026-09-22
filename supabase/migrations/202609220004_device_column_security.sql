revoke select on table public.devices from anon, authenticated;

grant select (
  id,
  device_code,
  display_name,
  description,
  firmware_version,
  last_seen,
  wifi_rssi,
  sd_ok,
  sps30_ok,
  sht3x_ok,
  rtc_ok,
  current_filename,
  current_file_size,
  created_at,
  updated_at
) on table public.devices to authenticated;

grant select (
  id,
  device_code,
  display_name,
  description,
  firmware_version,
  last_seen,
  wifi_rssi,
  sd_ok,
  sps30_ok,
  sht3x_ok,
  rtc_ok,
  current_filename,
  current_file_size,
  created_at,
  updated_at
) on table public.devices to anon;

comment on column public.devices.secret_hash is 'Server-only device credential hash. Browser roles have no column privilege.';
comment on column public.devices.ip_address is 'Operational metadata withheld from browser roles.';
