# AQ Observatory

A research-grade remote monitoring dashboard for XIAO ESP32-S3 environmental loggers. It presents five-minute SPS30/SHT3x summaries, heartbeat-derived status, hardware diagnostics, SD file catalogs, and secure on-demand CSV transfer—without replacing the existing local ESP32 dashboard or permanently mirroring full-resolution data.

## Screenshots

_Add production screenshots here after the first GitHub Pages deployment._

## Run locally

Requirements: Node.js 22+, npm 10+, and optionally the Supabase CLI.

```bash
npm install
copy .env.example .env.local
```

Set `VITE_DEMO_MODE=true`, then run `npm run dev`. Demo measurements are deterministic, browser-only, and clearly labelled. Production requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`; neither is a privileged secret when RLS is correctly configured.

```bash
npm run test
npm run lint
npm run build
npm run preview
```

The app uses `HashRouter`, so deep links work on GitHub Pages. The Vite build automatically uses `/aq-remote-dashboard/` during GitHub Actions.

## Architecture and setup

- [Architecture](docs/ARCHITECTURE.md)
- [Supabase and GitHub deployment](docs/DEPLOYMENT.md)
- [ESP32 API and firmware integration](docs/ESP32_INTEGRATION.md)
- [Security model](docs/SECURITY.md)

Apply migrations with `supabase db push`; they create constrained tables, indexes, RLS policies, a private temporary bucket, and device-secret verification. Deploy the Edge Functions using the exact command in the deployment guide.

## Environment

| Variable | Purpose |
|---|---|
| `VITE_SUPABASE_URL` | Project API URL |
| `VITE_SUPABASE_ANON_KEY` | Browser-safe anon key, protected by RLS |
| `VITE_PUBLIC_READ_ONLY` | Reserve a read-only UI mode |
| `VITE_DEMO_MODE` | Use isolated static preview data |
| `VITE_APP_NAME` | Deployment label |

## Troubleshooting

- Blank production data: confirm migrations, Auth session, RLS, and frontend variables.
- GitHub assets 404: keep the repository name `aq-remote-dashboard` or change `base` in `vite.config.ts`.
- Device 401: verify exact header names and bcrypt hash provisioning; never reuse IITD credentials.
- Missing chart points: nulls and missed uploads intentionally render as gaps.
- CSV not available: confirm the logger polled and acknowledged the command, storage bucket is private, and the request has not expired.

Full-resolution acquisition, RTC, OLED, SD logging, Wi-Fi connection management, HTTP retries, command polling, chunked upload, and watchdog-safe task scheduling still require ESP32 firmware integration. Cloud failure must never affect local logging.
