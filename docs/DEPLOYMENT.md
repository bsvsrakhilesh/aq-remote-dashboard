# Deployment

## Supabase

1. Create a Supabase project and install the CLI.
2. Run `supabase link --project-ref <ref>` then `supabase db push`.
3. Create the first Auth user in Authentication → Users.
4. Register each new physical logger with the admin-only SQL Editor helper in [Fleet provisioning](FLEET_PROVISIONING.md). Existing registered devices keep their current keys.
5. Set secrets: `supabase secrets set ALLOWED_ORIGINS=http://localhost:5173,https://<user>.github.io CLEANUP_SECRET=<random-secret>`.
6. Deploy: `supabase functions deploy device-heartbeat device-telemetry device-next-command device-command-ack device-file-catalog request-file-list request-file-download cancel-file-download device-upload-session device-download-progress device-download-complete device-download-failed cleanup-expired-downloads`.
7. Schedule cleanup with Supabase Cron or a trusted scheduler that POSTs to the cleanup function with `X-Cleanup-Secret`.

### Device ID in firmware

The ready-to-upload indoor sketch and private-key setup are documented in [aq_indoor01 setup](AQ_INDOOR01_SETUP.md); the SPS30 + SHT3x variant is in [aq_outdoor01 setup](AQ_OUTDOOR01_SETUP.md). Migration `202609230001_lowercase_device_code.sql` renames the existing `AQ01` record to `aq_indoor01`, preserving its UUID, secret hash, and linked data. Device authentication is case-sensitive. The corresponding dashboard route is `#/device/aq_indoor01`. The isolated demo still uses example IDs such as `AQ01`.

### Optional public read-only mode

Enable both gates together. In trusted SQL run `update public.dashboard_settings set public_read_only = true, updated_at = now() where id = true;`, then set the GitHub Actions variable `VITE_PUBLIC_READ_ONLY=true`. Anonymous visitors can read devices and telemetry only; file metadata, settings, commands, and downloads remain inaccessible. Set both values back to `false` to restore authenticated-only access.

## GitHub Pages

Set repository Actions variables `VITE_SUPABASE_URL`, `VITE_PUBLIC_READ_ONLY=false`, `VITE_DEMO_MODE=false`, and Actions secret `VITE_SUPABASE_ANON_KEY`. In Settings → Pages select **GitHub Actions**. Push `main`; the workflow tests, builds, and publishes. The expected URL is `https://<github-username>.github.io/aq-remote-dashboard/`.
