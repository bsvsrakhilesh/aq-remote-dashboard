# Deployment

## Supabase

1. Create a Supabase project and install the CLI.
2. Run `supabase link --project-ref <ref>` then `supabase db push`.
3. Create the first Auth user in Authentication → Users.
4. Add a device with a bcrypt hash: `insert into devices(device_code,display_name,secret_hash) values ('AQ01','Main Gate',extensions.crypt('<32-byte-secret>',extensions.gen_salt('bf')));`.
5. Set secrets: `supabase secrets set ALLOWED_ORIGINS=http://localhost:5173,https://<user>.github.io CLEANUP_SECRET=<random-secret>`.
6. Deploy: `supabase functions deploy device-heartbeat device-telemetry device-next-command device-command-ack device-file-catalog request-file-list request-file-download cancel-file-download device-upload-session device-download-progress device-download-complete device-download-failed cleanup-expired-downloads`.
7. Schedule cleanup with Supabase Cron or a trusted scheduler that POSTs to the cleanup function with `X-Cleanup-Secret`.

### Optional public read-only mode

Enable both gates together. In trusted SQL run `update public.dashboard_settings set public_read_only = true, updated_at = now() where id = true;`, then set the GitHub Actions variable `VITE_PUBLIC_READ_ONLY=true`. Anonymous visitors can read devices and telemetry only; file metadata, settings, commands, and downloads remain inaccessible. Set both values back to `false` to restore authenticated-only access.

## GitHub Pages

Set repository Actions variables `VITE_SUPABASE_URL`, `VITE_PUBLIC_READ_ONLY=false`, `VITE_DEMO_MODE=false`, and Actions secret `VITE_SUPABASE_ANON_KEY`. In Settings → Pages select **GitHub Actions**. Push `main`; the workflow tests, builds, and publishes. The expected URL is `https://<github-username>.github.io/aq-remote-dashboard/`.
