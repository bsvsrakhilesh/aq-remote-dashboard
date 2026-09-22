# Security model

- Human users authenticate with Supabase Auth. RLS limits browser reads and makes download requests user-owned.
- Optional anonymous access is double-gated by `VITE_PUBLIC_READ_ONLY=true` and `dashboard_settings.public_read_only=true`. Its RLS policies expose only devices and five-minute telemetry—not files, commands, downloads, or configuration.
- ESP32 devices receive unique random credentials. Edge Functions validate the bcrypt hash through a service-role-only function; secrets are not shared between devices.
- Browser roles receive column-level access to safe device metadata only. `devices.secret_hash` and `devices.ip_address` cannot be selected through authenticated or anonymous API requests, even when RLS permits the row.
- The frontend contains only the publishable anon key. Never place the service-role key, device keys, or Wi-Fi credentials in GitHub variables prefixed with `VITE_`.
- Temporary CSV objects live in a private bucket under `<device>/<request UUID>/<sanitized filename>`. Signed transfers expire after 15 minutes. Schedule `cleanup-expired-downloads` every 5–10 minutes using Supabase Cron or an external trusted scheduler and set `CLEANUP_SECRET`.
- Set `ALLOWED_ORIGINS` to `http://localhost:5173,https://<user>.github.io`. Privileged functions do not use wildcard CORS.
- Add project-level rate limits: heartbeat ~2/min/device, telemetry ~1/min/device, polling ~12/min/device, and file requests ~10/hour/user. Monitor repeated authentication failures.
- Validate filename containment again in firmware and backend. No destructive, firmware, calibration, shell, Wi-Fi, or format command is accepted by the database constraint.

Rotate a compromised device secret by updating its bcrypt hash, then reprovision only that device. Use Supabase logs without logging credential headers or signed URLs.
