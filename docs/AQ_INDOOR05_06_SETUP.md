# `aq_indoor05` and `aq_indoor06` setup

These two XIAO ESP32S3 sketches adapt the existing indoor SPS30 + SCD30 cloud logger to the direct wiring in `PM_CO2_4pinOLED.ino`. They retain the indoor logger's weekly SD files, local diagnostic page, Wi-Fi provisioning, IITD enterprise Wi-Fi support, and fifteen-minute combined cloud check-ins. The original sketch remains unchanged. Neither unit uses the XIAO expansion board or its buzzer.

| Connection                                            | XIAO pin / setting |
| ----------------------------------------------------- | ------------------ |
| External 4-pin SSD1306 OLED, SCD30, SPS30, DS3231 SDA | D4                 |
| External 4-pin SSD1306 OLED, SCD30, SPS30, DS3231 SCL | D5                 |
| OLED I2C address                                      | `0x3C`             |
| Separate microSD module CS                            | D7                 |
| Separate microSD module MOSI / MISO / SCK             | D10 / D9 / D8      |

Supply each module using its own rated voltage and a common logic ground. Check the external microSD module's logic-level requirements before connecting it to the 3.3 V XIAO pins. The new sketches do not assign D2 or D3 to an expansion board.

## Give each logger its own cloud identity

The firmware IDs are `aq_indoor05` and `aq_indoor06`, with mDNS names `aq-indoor05.local` and `aq-indoor06.local`. The sketches do not contain production device secrets. This workspace has distinct generated keys in each unit's git-ignored `private_config.h` and a matching, git-ignored `firmware/aq_indoor05_06_registration.private.sql`. Do not share or commit those files.

**Linked project status (2026-11-10):** Both devices are registered in Supabase with SPS30 + SCD30 inventory and CO₂ enabled. Their stored key hashes match the private registration script; the device IDs must not be registered again. `last_seen` stays empty until each flashed logger connects and checks in.

The private registration script has already been run for the linked project. Do not run it again or use `logger_admin.register_logger` for these two IDs: that helper would create different keys if the IDs were absent in another project. On another checkout or project where the private files are absent, use the standard registration helper described in [fleet provisioning](FLEET_PROVISIONING.md) and copy its returned keys into separate private configs instead.

Set `INDOOR_IITD_USERNAME` in each private config before using IITD Wi-Fi. The unique device keys are already set there; do not replace them with another logger's key.

Open `firmware/aq_indoor05/aq_indoor05.ino` or `firmware/aq_indoor06/aq_indoor06.ino` in Arduino IDE, select **XIAO ESP32S3**, and upload to the corresponding unit. At 115200 baud, confirm the OLED, RTC, sensors, and SD diagnostics. Connect Wi-Fi with the serial `wifi scan` flow; the logger continues SD logging while offline. Once online, check the local diagnostic page and the matching dashboard device page. The two units use the same cloud cadence as indoor 04. They do not broadcast to the separate three-logger ESP-NOW fan controller.
