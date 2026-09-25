# Registering the logger fleet

The dashboard already reads each logger from `public.devices`; no device list is hard-coded in the frontend. The database records the sensor pair in `installed_sensors`. The planned fleet has six SPS30 + SHT3x loggers and four SPS30 + SCD30 loggers, but the schema does not enforce these counts so future additions remain possible.

## One-time database setup

From the repository root, apply the latest migration:

```powershell
npx.cmd supabase db push
```

Migration `202609240003_logger_registration.sql` creates an administrator-only SQL Editor helper in the non-exposed `logger_admin` schema. It creates a unique 32-byte device key, stores only its bcrypt hash, and fills the correct sensor inventory fields. It refuses to change the key of an existing device.

## Register each new logger

First inspect what already exists in Supabase **SQL Editor**:

```sql
select device_code, display_name, installed_sensors, last_seen
from public.devices
order by device_code;
```

For a new SPS30 + SHT3x logger, run this once with its actual ID and name:

```sql
select * from logger_admin.register_logger(
  'aq_outdoor01', 'Outdoor 01', 'sht3x', 'SPS30 + SHT3x logger'
);
```

For a new SPS30 + SCD30 logger, use `scd30` as the third argument and that logger's own ID and name:

```sql
select * from logger_admin.register_logger(
  'REPLACE_WITH_NEW_DEVICE_ID', 'REPLACE_WITH_NAME', 'scd30', 'SPS30 + SCD30 logger'
);
```

Copy the returned `device_secret` immediately into that logger's **private, git-ignored firmware configuration**. Do not reuse a key across devices or commit it to GitHub. The key cannot be read back from the database; only its hash is stored. Existing registered loggers should keep their current keys and must not be registered again.

Repeat for each new unit. The `device_code` in the SQL call must exactly match `CLOUD_DEVICE_ID` in its firmware. A shared firmware template is fine, but each physical logger needs its own code and key.

To see how many are registered in each sensor pair:

```sql
select
  count(*) filter (where installed_sensors @> array['sps30', 'sht3x']::text[]) as sps30_sht3x,
  count(*) filter (where installed_sensors @> array['sps30', 'scd30']::text[]) as sps30_scd30
from public.devices;
```

The production dashboard shows new devices automatically as soon as their rows exist. `last_seen` fills after the device sends its first successful heartbeat. The helper changes only database provisioning; it does not flash devices or generate firmware files for the remaining units.
