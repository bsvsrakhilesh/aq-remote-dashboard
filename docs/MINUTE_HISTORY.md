# Twice-daily CSV history

Each device has a **One-minute history** tab beside its live readings. The cloud requests existing weekly SD CSV files twice daily, at **00:00 and 12:00 IST**. No firmware changes, new device credentials, or open browser are required. Devices must be powered, online, and already support the dashboard's file-download command.

The page has a device selector, IST date selector, import status, data-through timestamp, coverage counts, and a pause/resume control for signed-in users. Outdoor devices show PM1, PM2.5, PM10, temperature and humidity; indoor devices also show CO₂. The live readings page is unchanged.

## How it works

- A cloud coordinator checks pending work every minute, but creates only one snapshot job per device/file per 12-hour slot. It invokes the CSV worker only when a transfer is ready.
- It uses the existing `download_file` command and private temporary storage. Three automatic transfers run at most, with existing manual transfers taking priority.
- Offline devices catch up when they reconnect within the current slot. Full weekly snapshots recover missed samples within that file. At weekly rollover, the previously synced file gets a final snapshot. Files from weeks never observed online are not automatically discovered.
- Rows are grouped by verified IST minute, converted to UTC for storage, and averaged separately for each measurement. Invalid values are excluded; missing minutes stay gaps. Duplicate RTC seconds and incomplete final lines are excluded. No values are interpolated from live five-minute readings.
- Only data before the latest midnight/noon cutoff is imported. Before noon, today's page can therefore be empty; select yesterday.
- Retries are bounded to three attempts, separated by at least 15 minutes. Retries and the weekly closing snapshot can cause extra transfers beyond the two regular daily syncs.
- Successful imports delete only their temporary cloud copies. SD files are never deleted or rewritten. Unsynced recovery files are excluded because their wall-clock timestamps are not verified.

## Deployment

Deploy `process-csv-history` with JWT gateway verification disabled (configured in `supabase/config.toml`), then apply the database migrations using `npx.cmd supabase db push`. The worker authenticates with a separate random Vault token created by the migration. Never copy this token to firmware or frontend code.

Migration `202609250002_csv_history_schedule.sql` targets this repository's linked Supabase project. Change its worker URL before deploying a separate project. Scheduling follows the official [Supabase Cron](https://supabase.com/docs/guides/cron) / [scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions) pattern.

## Usage and limits

The existing firmware sends the **entire weekly CSV** for each request, not just new rows. File size grows through the week; storage traffic and database usage are not unlimited or guaranteed free. Watch Supabase usage for your fleet. Transfers are capped at 100 MiB each. Pause per-device automatic sync if needed. Minute-history records currently remain until explicitly removed; plan retention before long-term fleet operation.

Pausing prevents new transfers but allows an already-started transfer to finish. A paused/offline logger's SD logging remains independent of the dashboard.
