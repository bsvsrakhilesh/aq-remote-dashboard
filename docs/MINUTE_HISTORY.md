# Twice-daily CSV history

Each device has a **One-minute history** tab beside its live readings. The cloud requests completed rows from weekly SD CSV files twice daily, after **00:00 and 12:00 IST**. Automatic sync requires firmware **1.2.5 or newer**. Devices must be powered and online; no open browser is required.

Newly registered loggers start with automatic one-minute sync paused. Existing loggers keep their previous setting. This prevents adding loggers from silently increasing Storage egress and database growth. A signed-in user can enable sync per logger in the One-minute history tab after reviewing capacity.

The page has a device selector, IST date selector, import status, data-through timestamp, coverage counts, and a pause/resume control for signed-in users. Outdoor devices show PM1, PM2.5, PM10, temperature and humidity; indoor devices also show CO₂. The live readings page is unchanged.

## How it works

- A cloud coordinator checks pending work every fifteen minutes, but creates only one snapshot job per device/file per 12-hour slot. It invokes the CSV worker only when a transfer is ready.
- It uses the existing `download_file` command and private temporary storage. Three automatic transfers run at most, with existing manual transfers taking priority.
- The first sync of a weekly file transfers rows from the beginning. Later syncs transfer the CSV header and only new complete rows before the cutoff. The worker commits the next byte offset only after saving the minute averages. At weekly rollover, the previously synced file gets a final incremental transfer. Files from weeks never observed online are not automatically discovered.
- Rows are grouped by verified IST minute, converted to UTC for storage, and averaged separately for each measurement. Invalid values are excluded; missing minutes stay gaps. Duplicate RTC seconds and incomplete final lines are excluded. No values are interpolated from live fifteen-minute readings.
- Only data before the latest midnight/noon cutoff is imported. Before noon, today's page can therefore be empty; select yesterday.
- Retries are bounded to three attempts, separated by at least 15 minutes. Retries and the weekly closing snapshot can cause extra transfers beyond the two regular daily syncs. Existing manual full-file downloads remain available.
- Successful imports delete only their temporary cloud copies. SD files are never deleted or rewritten. Unsynced recovery files are excluded because their wall-clock timestamps are not verified.

## Deployment

Apply the database migrations, then deploy `device-upload-session`, `device-download-complete`, `process-csv-history`, and `device-check-in`. The worker authenticates with a separate random Vault token created by the migration. Never copy this token to firmware or frontend code. Flash all seven logger sketches to 1.2.5 before powering them on; older versions are blocked from automatic CSV sync and still send frequent Edge requests.

Migration `202609250002_csv_history_schedule.sql` targets this repository's linked Supabase project. Change its worker URL before deploying a separate project. Scheduling follows the official [Supabase Cron](https://supabase.com/docs/guides/cron) / [scheduled functions](https://supabase.com/docs/guides/functions/schedule-functions) pattern.

## Usage and limits

The first transfer of an existing weekly file can still be large. File transfers are capped at 100 MiB each. Supabase egress and database storage are limited on the Free tier, so monitor both as the fleet grows. At the observed data rate, fifty loggers could exceed the Free egress allowance even with incremental CSV sync. Keep high-volume history opt-in and retain full-resolution originals on SD. The one-minute history table has no automatic retention until a per-device policy is configured; plan retention before long-term fleet operation.

Pausing prevents new transfers but allows an already-started transfer to finish. A paused/offline logger's SD logging remains independent of the dashboard.
