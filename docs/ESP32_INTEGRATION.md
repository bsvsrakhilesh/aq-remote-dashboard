# ESP32 integration contract

Cloud work is secondary. Use short timeouts, an independent FreeRTOS task or a cooperative state machine, small fixed buffers, exponential retry, and `yield()` between chunks. Failed network work must never pause sampling or SD writes.

All device endpoints use `POST` except command polling. Include `X-Device-ID: AQ01`, `X-Device-Key: <unique random secret>`, and `Content-Type: application/json`. Base URL: `https://<project-ref>.supabase.co/functions/v1`.

| Operation          | Method and path                  | Typical response                     |
| ------------------ | -------------------------------- | ------------------------------------ |
| Heartbeat          | `POST /device-heartbeat`         | `{"ok":true}`                        |
| Five-minute sample | `POST /device-telemetry`         | `{"ok":true}`                        |
| Poll commands      | `GET /device-next-command`       | `{"command":null}` or command object |
| Acknowledge        | `POST /device-command-ack`       | `{"ok":true}`                        |
| File catalog       | `POST /device-file-catalog`      | `{"ok":true,"count":2}`              |
| Start upload       | `POST /device-upload-session`    | signed upload destination            |
| Report progress    | `POST /device-download-progress` | calculated percentage                |
| Finish upload      | `POST /device-download-complete` | expiry timestamp                     |
| Report failure     | `POST /device-download-failed`   | terminal failed status               |

Heartbeat body:

```json
{
  "timestamp": "2026-09-22T16:20:10+05:30",
  "rssi": -72,
  "sd_ok": true,
  "sps30_ok": true,
  "sht3x_ok": true,
  "rtc_ok": true,
  "current_file": "AQ01_2026-09-22.csv",
  "current_file_size": 18342592,
  "firmware_version": "1.0.0"
}
```

Telemetry body:

```json
{ "timestamp": "2026-09-22T16:20:00+05:30", "pm25": 18.4, "pm10": 31.2, "temperature": 26.4, "rh": 58.0 }
```

File-catalog body: `{"command_id":"<list-files-command-uuid>","files":[{"name":"AQ01_2026-09-22.csv","size_bytes":18634259,"created_at":"2026-09-22T16:20:00+05:30"}]}`. Listing sends metadata only. Supplying the command ID atomically marks the catalog command complete. For the SPS30/SCD30 logger, `created_at` comes from the first RTC-stamped CSV data row—the earliest reliable record of when the file began. Omit it if that row is missing or invalid; the dashboard will show “Date unavailable.” Older loggers may still send `modified_at`, but the Created column does not substitute it for creation time.

## Firmware pseudocode

### SCD30 CO₂ on aq_indoor01

This logger has CO₂ enabled in the registry. Use `X-Device-ID: aq_indoor01` with its existing device secret. Send the SCD30's measured CO₂ concentration as the optional numeric `co2` field in the same five-minute telemetry request:

```json
{
  "timestamp": "2026-09-23T16:20:00+05:30",
  "pm25": 18.4,
  "pm10": 31.2,
  "temperature": 26.4,
  "rh": 58.0,
  "co2": 812.5
}
```

These are example values, not readings to hardcode. In firmware, add `telemetry["co2"] = co2Ppm;` to the JSON object using the actual SCD30 measurement. The backend stores it as `telemetry_5min.co2_ppm`. Send a JSON number in ppm, without a unit suffix or surrounding quotes. Omit the field or send `null` when the sensor has no valid measurement, including startup, read failures, or stale samples. Zero, negative values, non-finite values, and concentrations above 1,000,000 ppm are rejected with HTTP 400 `invalid_co2`. This broad storage limit is not a claim about sensor accuracy or operating range.

Add the optional field `"scd30_ok": true` to the heartbeat when the SCD30 is working, `false` on a detected sensor fault, or `null` when its status is unknown. Older firmware can omit it; the dashboard then shows **Not reported**. Existing temperature/RH fields keep their current source.

The separately supplied `PM_CO2_XIAO_Expansion_IITD_CLOUD.ino` already acquires SCD30 measurements. Its cloud integration adds these lines to `sendCloudTelemetry()` and `sendCloudHeartbeat()`, respectively:

```cpp
body += ",\"co2\":" + jsonFloatOrNull(co2Concentration, scdOk && co2Concentration > 0 && co2Concentration <= 1000000);
body += ",\"scd30_ok\":" + String(scd30DataUsable(millis()) ? "true" : "false");
```

This uses the sketch's existing freshness check and sends `null` for unusable CO₂ samples. The configured sketch is kept local, outside the public repository, because firmware configuration may contain device and Wi-Fi credentials. Compile and upload that updated sketch to the logger; deploying the website alone does not update its firmware.

The local sketch is configured for project `qnrfwfuyxuzqdcbgrwdd` and device `aq_indoor01`. Before flashing, replace the `CLOUD_DEVICE_SECRET` placeholder with this device's existing secret. For IITD_WIFI, also replace the `IITD_EAP_IDENTITY` and `IITD_EAP_USERNAME` placeholders with your own account values; enter the Wi-Fi password through the logger's existing local setup flow. Its Edge Functions use device headers with `verify_jwt=false`, so `CLOUD_SUPABASE_ANON_KEY` stays empty. Never put a service-role key in the sketch.

The logger's installed sensors are recorded in `devices.installed_sensors`. This unit is `['sps30','scd30']`; temperature and RH come from SCD30. Other units can keep `['sps30','sht3x']` or their actual inventory. Configure each device when registering it. An absent SHT3x is hidden from health checks rather than shown as broken. The network name is `aq-indoor01.local` (hyphen), while the database device code and existing CSV prefix remain `aq_indoor01` (underscore).

The updated sketch sends cloud requests from a FreeRTOS worker, allowing sensor acquisition and SD writes to continue during TLS operations. Its CSV transfer uses a fixed byte snapshot of the weekly file, reports progress, and distinguishes completed uploads from failures. Requested CSV copies are limited to 100 MiB by the Supabase bucket. Local SD logging still holds the complete research data.

The dashboard shows a CO₂ value, a ppm history chart with all four time ranges, and SCD30 health only when `devices.co2_enabled` is true. The migration enables this for `aq_indoor01`; other loggers remain unchanged. Existing telemetry rows have `NULL` CO₂ and are not backfilled. For another CO₂-equipped logger, enable the flag through trusted SQL. Firmware should continue SD logging independently of cloud requests.

### Background cloud task

```cpp
void cloudTask() {
  if (heartbeatDue()) sendHeartbeat();
  if (fiveMinuteSummaryDue()) sendFiveMinuteTelemetry();
  if (commandPollDue()) pollCommands();
}

void pollCommands() {
  // GET next command with a short timeout.
  // Acknowledge before work. list_files -> scan metadata only.
  // download_file -> call uploadRequestedFile(request_id, filename).
}

void uploadRequestedFile(String requestId, String filename) {
  // Validate that filename resolves inside the SD data directory.
  // Request signed upload session with total file length.
  // Open SD file and stream 8–32 KiB chunks; never load it all in RAM.
  // Between chunks, yield and service acquisition/SD logging first.
  // Report completion only after storage confirms the final byte.
}
```

The human-facing dashboard uses two additional authenticated functions: `POST /request-file-list` queues a deduplicated catalog command, and `POST /cancel-file-download` expires a user-owned transfer and removes any partial temporary object. These endpoints use the browser's Supabase Auth token, never device credentials.

Progress body: `{"request_id":"<uuid>","bytes_uploaded":7340032,"total_bytes":18634259}`. Report after meaningful increments, not for every packet.

If a transfer cannot resume, POST `{"request_id":"<uuid>","error":"SD read failed"}` to `/device-download-failed`. Keep error text short and never include credentials.

The included signed-upload contract isolates storage behind one endpoint. Validate direct streaming with the chosen ESP32 HTTP client before field deployment: Supabase standard signed uploads are best for stable single-request transfers. For unreliable links or files beyond the configured 100 MB bucket limit, switch this endpoint to Supabase resumable/TUS upload or another multipart-capable object store without changing the browser workflow.

Provision secrets separately from IITD Wi-Fi credentials. Generate at least 32 random bytes, store the bcrypt hash in `devices.secret_hash` using `extensions.crypt('<secret>', extensions.gen_salt('bf'))`, and flash the plaintext only onto its assigned logger.
