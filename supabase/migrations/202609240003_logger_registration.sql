-- Run this migration before using the SQL Editor registration helper.
-- Keep provisioning outside the exposed Data API schemas: only a trusted
-- database administrator should receive a newly generated device key.
begin;

create schema if not exists logger_admin;
revoke all on schema logger_admin from public, anon, authenticated, service_role;

create function logger_admin.register_logger(
  p_code text,
  p_name text,
  p_sensor text,
  p_description text default null
)
returns table(device_code text, device_secret text)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_code text := pg_catalog.btrim(p_code);
  v_name text := pg_catalog.btrim(p_name);
  v_secret text;
begin
  if v_code is null or v_code !~ '^[a-z0-9_-]{2,32}$' then
    raise exception 'Device code must be 2-32 lowercase letters, digits, underscores, or hyphens';
  end if;

  if v_name is null or v_name = '' then
    raise exception 'Display name is required';
  end if;

  if p_sensor is null or p_sensor not in ('sht3x', 'scd30') then
    raise exception 'Sensor must be sht3x or scd30';
  end if;

  if exists (select 1 from public.devices d where d.device_code = v_code) then
    raise exception 'Device % already exists; its key was not changed', v_code;
  end if;

  v_secret := pg_catalog.encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.devices (
    device_code,
    display_name,
    description,
    secret_hash,
    co2_enabled,
    installed_sensors
  ) values (
    v_code,
    v_name,
    p_description,
    extensions.crypt(v_secret, extensions.gen_salt('bf')),
    p_sensor = 'scd30',
    array['sps30', p_sensor]::text[]
  );

  return query select v_code, v_secret;
end;
$$;

revoke all on function logger_admin.register_logger(text, text, text, text)
  from public, anon, authenticated, service_role;

comment on function logger_admin.register_logger(text, text, text, text) is
  'Admin-only SQL Editor helper. Creates one logger and returns its unique device key once; only its hash is stored.';

commit;
