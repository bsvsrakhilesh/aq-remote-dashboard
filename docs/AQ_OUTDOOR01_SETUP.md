# `aq_outdoor01` setup

The sketch is [`firmware/aq_outdoor01/aq_outdoor01.ino`](../firmware/aq_outdoor01/aq_outdoor01.ino). Configure its private device key before uploading it. It is for a Seeed XIAO ESP32S3 with SPS30, SHT3x (I2C address `0x44`), DS3231, OLED, and the expansion-board SD card. It sends PM1, PM2.5, PM10, temperature, and relative humidity.

1. Apply the latest Supabase migrations from the repo root:

   ```powershell
   npx.cmd supabase db push
   ```

2. Open your Supabase project → **SQL Editor** → **New query**. If `aq_outdoor01` has not yet been registered, run:

   ```sql
   select * from logger_admin.register_logger(
     'aq_outdoor01', 'Outdoor 01', 'sht3x', 'SPS30 + SHT3x outdoor logger'
   );
   ```

   Copy `device_secret` from the result immediately; it is shown once and only its hash is stored. Keep it private. If the row already exists, the helper refuses to change its key—use that logger's existing key instead. **For the currently linked project, `aq_outdoor01` is already registered and its key is in the local `private_config.h`; do not run this call again.** See [fleet provisioning](FLEET_PROVISIONING.md) for the other units.

3. On a fresh installation only, copy the example configuration. Do not overwrite an existing `private_config.h`:

   ```powershell
   if (!(Test-Path 'firmware\aq_outdoor01\private_config.h')) {
     Copy-Item 'firmware\aq_outdoor01\private_config.example.h' 'firmware\aq_outdoor01\private_config.h'
   }
   ```

   For a newly registered project, open `firmware\aq_outdoor01\private_config.h` and replace `YOUR_DEVICE_SECRET` with the `device_secret` returned in step 2. If using `IITD_WIFI`, also set `OUTDOOR_IITD_USERNAME`. Never put your IITD password in this file; the firmware asks for it through Serial and stores it on the ESP32 after a successful connection. `private_config.h` is git-ignored. Preserve this file securely when moving to another computer; the database cannot reveal the key again.

4. Open `firmware\aq_outdoor01\aq_outdoor01.ino` in Arduino IDE. Select **XIAO ESP32S3**, choose the serial port, and upload. The Supabase functions URL and device ID are already set. Device requests authenticate with `X-Device-ID` and the unique `X-Device-Key`; no Supabase anon key is needed in firmware.

5. Check the Serial Monitor at **115200 baud**. Supply Wi-Fi credentials if prompted. Local SD logging continues without Wi-Fi and uses a recovery CSV when time is unverified. It creates weekly CSV files when time is verified. After the first successful SD row, the buzzer gives two beeps. Cloud heartbeat runs every minute; telemetry every five minutes; commands are polled every five seconds while connected.

6. Verify registration in the SQL Editor without exposing the key:

   ```sql
   select device_code, display_name, co2_enabled, installed_sensors,
          last_seen, sht3x_ok, sps30_ok
   from public.devices
   where device_code = 'aq_outdoor01';
   ```

   The device appears automatically on the production dashboard after the row exists. Its route is `#/device/aq_outdoor01`.

If `last_seen` stays empty after the ESP32 connects, inspect Serial for cloud HTTP errors. `401` usually means the device ID or key in the firmware does not match the database row; network errors mean Wi-Fi or HTTPS connectivity needs attention. Never share the device key when asking for help.
