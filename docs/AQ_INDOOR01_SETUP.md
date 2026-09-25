# `aq_indoor01` setup

The shareable sketch is [`firmware/aq_indoor01/aq_indoor01.ino`](../firmware/aq_indoor01/aq_indoor01.ino). It is for the XIAO ESP32S3 logger with SPS30, SCD30, DS3231, OLED, and expansion-board SD card. The original Arduino sketch in `Documents/Arduino/PM_CO2_XIAO_Expansion_IITD_CLOUD` has the same changes.

For the currently linked Supabase project, **`aq_indoor01` is already registered**. Its existing device key and IITD username have been moved into `firmware/aq_indoor01/private_config.h`, which is git-ignored. Do not register it again or replace its key. The Arduino sketch in Documents has its own copy of that private configuration beside the `.ino` file.

1. Open `firmware/aq_indoor01/aq_indoor01.ino` in Arduino IDE. Keep `private_config.h` in the same folder. Select **XIAO ESP32S3** and the correct serial port, then upload. You can instead upload the updated sketch in the Documents/Arduino folder; it also has `private_config.h` beside it.
2. Open Serial Monitor at **115200 baud**. Type `wifi scan`, select a network, and enter its password. For `IITD_WIFI`, the private config already contains the username; enter the IITD password only in Serial Monitor. Do not put the password in the sketch or in Git.
3. Watch for Wi-Fi connection and cloud status messages. If the hotspot connection fails, note the `Wi-Fi disconnected (reason code ...)` line. SD logging continues while offline.
4. Once online, open the dashboard device route `#/device/aq_indoor01`. The logger sends a heartbeat every minute and telemetry every five minutes. The device appears automatically because its database row already exists.

On another computer, copy `private_config.example.h` to `private_config.h`, then fill in that device's existing key and IITD username. Never commit or share `private_config.h`. The database stores only the key hash and cannot show the original key again. Each additional physical logger needs its **own** device ID and key; do not flash this `aq_indoor01` identity onto the other indoor units. See [fleet provisioning](FLEET_PROVISIONING.md).
