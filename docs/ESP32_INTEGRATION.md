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

File-catalog body: `{"command_id":"<list-files-command-uuid>","files":[{"name":"AQ01_2026-09-22.csv","size_bytes":18634259,"modified_at":"2026-09-22T16:20:00+05:30"}]}`. Listing sends metadata only. Supplying the command ID atomically marks the catalog command complete.

## Firmware pseudocode

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
