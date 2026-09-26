# Research workspace upgrade

Goal: implement the complete dashboard-only feature set, with a cohesive, accessible interface. Both logger firmware variants are frozen. Automatic CSV collection stays twice daily, at midnight and noon IST.

## Acceptance checklist

- [x] Compare selected devices and measurements with aligned time axes and honest gaps.
- [x] Daily/weekly summaries, CSV export and print-ready PDF reports.
- [x] Durable offline and sustained-threshold alerts, acknowledgement and notification centre.
- [x] Explainable missing/stale/spike/incomplete-minute checks; never rewrite raw measurements.
- [x] Fleet heatmap by hour/day with units, a legend and accessible values.
- [x] Device deployment/location and maintenance notes persisted in the database.
- [x] Validated historical SD CSV import with preview, provenance and bounded retries; selected-data export.
- [x] Fleet sync status, next schedule, pause/resume and rate-limited manual sync.
- [x] Storage usage and opt-in retention, with preview/confirmation before deletion.
- [x] Saved devices/date ranges/metrics/layouts with persistence and validation.
- [x] Responsive light/dark UI, loading/empty/error states, keyboard access and print layout.
- [x] Unit tests, database security tests and browser interaction checks; deploy and verify production.

## Design and data rules

Use existing visual tokens, typography and navigation. Organize into Analysis (comparison, heatmap, reports and quality), Operations (alerts, deployment notes and sync), and Data library (import, export and retention). No synthetic values in production; demo fixtures remain isolated. Display IST explicitly. Distinguish five-minute snapshots from minute averages and account for the last scheduled CSV cutoff in coverage calculations.

In-app alerts are evaluated in the cloud and retained while the browser is closed. Optional browser notifications require explicit permission and an open dashboard; do not imply email/SMS delivery. PDF uses the browser's print/save-to-PDF workflow. Retention is off by default and never deletes SD files. Thresholds are user-defined research settings, not medical or regulatory claims.

Historical imports stream the browser file in complete-minute chunks of approximately 2 MiB. Each chunk is parsed on the server and saved idempotently. The 100 MiB file cap and small per-request chunks account for the hosted Edge Function CPU limit; keep the browser tab open until the import finishes. If a transfer is interrupted, uploading the same file again is safe.

## Progress evidence

2026-09-25: inspected clean worktree at `10aa02f`, current routes, schemas, device types and CSV sync implementation. No firmware changes planned.

2026-09-27: Analysis, Operations, and Data library routes built. Supabase migrations 003–006 applied; cloud import function deployed. Research SQL returned live outdoor snapshot and minute data. Cron alert runs succeeded. Rollback-only database test covered aggregation, offline alert open/resolve, import retry idempotency, retention confirmation, and privileges. Sixty-one unit tests passed. Browser checks covered all three routes at 1440, 390 and 320 pixels in both colour themes, plus saved views, weekly reports, rules, notes, retention preview and CSV preview. Production publication remains to verify.

Production verification: commit `4a0d491` passed the GitHub Pages build and deployment workflow. The live app serves Analysis, Operations, and Data library chunks with the linked Supabase project configured. The import endpoint returned 401 without an authenticated user and accepted the production origin in its CORS preflight. The existing twice-daily CSV coordinator and the three new maintenance jobs are active. A temporary signed-in test user exercised the live analysis queries and the complete CSV start/chunk/finish flow against a temporary logger; the stored PM1 and PM2.5 averages were correct. The user, logger, test readings, and import record were removed, then independently verified absent from the database. Production browser sign-in under a real researcher account remains subject to that account's credentials and browser state.
