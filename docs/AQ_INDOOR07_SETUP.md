# `aq_indoor07` setup

The [logger 7 sketch](../firmware/aq_indoor07/aq_indoor07.ino) is based on `aq_indoor06`. It uses a XIAO ESP32S3, SPS30, SCD30, DS3231, external SSD1306 OLED, and a separate microSD module. Its cloud device ID is `aq_indoor07` and its local hostname is `aq-indoor07.local`.

| Connection                           | XIAO pin           |
| ------------------------------------ | ------------------ |
| OLED, SCD30, SPS30, DS3231 SDA / SCL | D4 / D5            |
| microSD CS / MOSI / MISO / SCK       | D7 / D10 / D9 / D8 |

In this workspace, `firmware/aq_indoor07/private_config.h` contains a unique generated device secret and the IITD username copied from logger 6. The matching, git-ignored `firmware/aq_indoor07/registration.private.sql` was run against the linked Supabase project on 2026-11-16. The `aq_indoor07` device row has SPS30 + SCD30 inventory and CO₂ enabled. **Do not run the registration script again or use `logger_admin.register_logger` for this ID**; that helper generates a different secret. Keep both private files out of Git and never reuse logger 6's key. Select **XIAO ESP32S3** in Arduino IDE and upload `aq_indoor07.ino`.

On another checkout without the private files, copy `private_config.example.h` to `private_config.h` and use the [standard fleet provisioning process](FLEET_PROVISIONING.md) to register a fresh key for that project.

On the logger's local page, use **Automatic Self-Calibration (ASC)** to read or change the SCD30's persistent ASC setting. ASC is off by default. Enable it only if the sensor sees fresh air near 400 ppm for at least one hour every day. Initial calibration requires at least seven days of continuous operation without removing sensor power.

Use **Force Recalibration (FRC)** with a measured, stable CO₂ reference placed close to the SCD30. The firmware accepts only whole-number references from 400 to 2000 ppm and requires fresh data after at least two minutes of continuous measurement at a 2-second interval. FRC permanently changes the sensor's CO₂ calibration curve. If ASC remains enabled, a later ASC correction can supersede the FRC correction. The FRC reference readback is volatile and resets to 400 ppm on sensor power-up; it is **not** a readout of the stored calibration.

These conditions and commands follow Sensirion's [SCD30 interface description](https://sensirion.com/media/documents/D7CEEF4A/6165372F/Sensirion_CO2_Sensors_SCD30_Interface_Description.pdf) and [field calibration guide](https://sensirion.com/en/media/documents/33C09C07/620638B8/Sensirion_SCD30_Field_Calibration.pdf).
