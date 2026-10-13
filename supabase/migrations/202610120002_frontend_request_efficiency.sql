-- One row per visible device, with its most recent cloud sample. Both source
-- tables retain their existing row-level security policies for the caller.
create view public.fleet_current_status with (security_invoker = true) as
select
  d.id,
  d.device_code,
  d.display_name,
  d.description,
  d.firmware_version,
  d.last_seen,
  d.wifi_rssi,
  d.sd_ok,
  d.sps30_ok,
  d.sht3x_ok,
  d.rtc_ok,
  d.current_filename,
  d.current_file_size,
  d.co2_enabled,
  d.scd30_ok,
  d.installed_sensors,
  latest.timestamp as latest_timestamp,
  latest.pm1 as latest_pm1,
  latest.pm25 as latest_pm25,
  latest.pm10 as latest_pm10,
  latest.temperature_c as latest_temperature_c,
  latest.rh as latest_rh,
  latest.co2_ppm as latest_co2_ppm
from public.devices d
left join lateral (
  select timestamp, pm1, pm25, pm10, temperature_c, rh, co2_ppm
  from public.telemetry_5min t
  where t.device_id = d.id
  order by t.timestamp desc
  limit 1
) latest on true;

revoke all on public.fleet_current_status from public;
grant select on public.fleet_current_status to anon, authenticated;

comment on view public.fleet_current_status is
  'One latest telemetry row per visible device; invoker RLS preserves the dashboard public-read gate.';
