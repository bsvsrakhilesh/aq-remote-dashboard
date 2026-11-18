# Axiom integration

AQ Remote Dashboard serves Axiom's frontend under `/aq-remote-dashboard/axiom/`. A lab machine runs the analysis API and receives requested snapshots. Production stays disabled until the migration, worker, and private HTTPS connection have been verified.

## Configure the lab

1. Copy `apps/axiom/.env.example` to `apps/axiom/.env`. Set `AXIOM_REQUIRE_AUTH=true`, the existing Supabase HTTPS URL and public key, and `AXIOM_OWNER_ID` to your user's UUID from Supabase Auth. Set `AXIOM_CORS_ORIGINS=https://bsvsrakhilesh.github.io`. Set `AXIOM_BUILD_REVISION` to the Git commit you are building.
2. Generate a random worker secret of at least 32 characters. Set it as `AXIOM_WORKER_SECRET` in the lab environment and in Supabase Edge Function secrets. Also set `AXIOM_OWNER_ID` in Edge Function secrets. Keep the secrets file out of Git. The browser build receives only public configuration.
3. In `apps/axiom`, run `docker compose --profile dashboard up -d --build`. Expose the loopback web service at port `3000` through Tailscale Serve or your institution's private HTTPS entry point. Test access from an authorized device. Keep the FastAPI container port private.

## Enable the dashboard

1. Back up the production database. Apply the Axiom migration using the Supabase deployment procedure. Deploy `axiom-transfers`, `device-upload-session`, `device-download-complete`, `request-file-download`, and `cleanup-expired-downloads`. Confirm the existing cleanup job runs every 15 minutes and removes expired temporary objects.
2. Set GitHub Actions variable `VITE_AXIOM_API_BASE_URL` to the private HTTPS origin, without `/api`. Keep the dashboard in authenticated mode. Set `VITE_AXIOM_ENABLED=true` and run the Pages deployment.
3. Send one original CSV and one daily minute export. Compare the original byte count and checksum with the logger copy and confirm minute coverage and timestamp alignment. Stop and restart the worker mid-transfer to check recovery. If the Pages browser cannot reach the private API, use **Open private workspace**.
4. Check the worker and estimated transfer budget in **Data files → Axiom transfers**. A queued file waits for the worker, and a raw transfer then waits for the logger to check in. Sources are only downloadable for a limited time. If a capture expires, send a new one. For files over 40 MiB, use the logger's local dashboard or SD card and import through Axiom.

**Pause transfers** stops new Axiom jobs and claims. Current deliveries can finish. The Supabase secret `AXIOM_PAUSED=true` also pauses the service. To roll back the UI, disable `VITE_AXIOM_ENABLED` and rebuild Pages. Preserve the Axiom state volume and the original logger files.

## Backups and retention

- In `apps/axiom`, configure restic using `RESTIC_REPOSITORY` and a protected password file. Use a second disk or a separate backup host. Initialize the repository once, then schedule `python scripts/backup-state.py` nightly on the lab machine. The script briefly stops volume writers during backup and restarts them afterward. A scheduled task failure should alert the operator.
- Once a month, restore the archive into a separate directory, extract `axiom-state.tar` there, and run `python scripts/verify-archive.py <restored-directory>`. Restore the checked state into a clean test instance at the same container path and reproduce one saved study. Keep a record of the restore.
- Automatic deletion of cloud minute rows is disabled for this integration. To move an older window out of cloud storage, send the minute range to Axiom and restore it from a backup. Run `python scripts/verify-archive.py <restored-directory> --job-id <job-id>`, then use the reported checksum as a database administrator to run `select public.prune_backed_up_axiom_minutes('<job-id>', '<sha256>');`. The function rejects windows newer than 30 days or whose rows differ from the verified snapshot. If rows changed, archive and verify the range again. Existing per-logger retention settings are separate from this workflow. Review them before enabling pruning.

## Scale and operating limits

Start with one logger and expand to 10, 25, and then 50. Review seven days of actual usage and project it through the billing cycle before each expansion. Require at least 95% of eligible transfers to arrive within 30 minutes when both the logger and worker are online. Keep automatic minute sync opt-in. At 70% of any shared provider quota, hold expansion and pause optional research transfers as needed to protect live monitoring.

The Axiom queue reserves up to 1 GiB in estimated reads per UTC month, including retries. It budgets up to 200 MiB of raw staging plus 8 MiB of minute exports. The worker waits 60 seconds between polls, handles one job at a time, and stops accepting data when it would leave the disk below 20% free. Supabase provider usage includes other features, so use the provider console for actual organization-wide usage.

For dashboard data, the Axiom date filters and time charts show IST even on a device set to another timezone. Time series and collocation CSV exports contain both `timestamp_ist` and `timestamp_utc`. The archived original CSV stays byte for byte as received.
