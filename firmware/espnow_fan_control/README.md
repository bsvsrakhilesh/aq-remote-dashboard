# ESP-NOW CO₂ fan control

This folder contains **new** Arduino sketches for `aq_indoor01`, `aq_indoor02`, `aq_indoor03`, and a Seeed XIAO ESP32-S3 fan controller. The original sketches in `firmware/aq_indoor01` through `03` remain available. The new logger copies retain their SCD30/SPS30 acquisition, OLED, SD logging, Wi-Fi provisioning, local web page, and cloud check-ins. Their only functional addition is an authenticated CO₂ broadcast every two seconds when a recent SCD30 reading exists.

## Files

| Path                                                         | Purpose                                        |
| ------------------------------------------------------------ | ---------------------------------------------- |
| `aq_indoor01/aq_indoor01.ino`                                | Logger 1 with ESP-NOW sender                   |
| `aq_indoor02/aq_indoor02.ino`                                | Logger 2 with ESP-NOW sender                   |
| `aq_indoor03/aq_indoor03.ino`                                | Logger 3 with ESP-NOW sender                   |
| `fan_controller/fan_controller.ino`                          | ESP-NOW receiver and fan controller            |
| [`fan_wiring.svg`](fan_wiring.svg)                           | Wiring concept and isolation boundary          |
| [`controller_local_dashboard/`](controller_local_dashboard/) | Optional wireless localhost dashboard over BLE |

## Control behavior

The controller uses the arithmetic mean of **all currently valid** logger readings. A logger is valid until its SCD30 sample is 60 seconds old, including the time since the controller received its packet. One or two missing loggers do not stop control; the mean uses the remaining logger(s). With no valid readings, the controller switches the relay **off**. Invalid, stale, duplicate, incorrectly signed, and packets from an unexpected MAC after pairing are ignored.

| Condition                                               | Action                                               |
| ------------------------------------------------------- | ---------------------------------------------------- |
| Mean strictly above 700 ppm continuously for 30 seconds | Switch fan on                                        |
| Mean strictly below 700 ppm                             | Switch fan off immediately                           |
| Mean exactly 700 ppm                                    | Keep current fan state; reset an unfinished on timer |
| All three readings absent/stale                         | Switch fan off and reset on timer                    |

After data returns, the full 30-second high-CO₂ hold is required again. At boot the relay driver is off. The code uses `millis()` and does not depend on NTP, a router, cloud service, or Internet. The loggers keep their previous Wi-Fi features for dashboard use.

If the controller receives a mean of **700 ppm or less** during the 30-second ON wait, it resets that wait; the next mean above 700 ppm starts a fresh 30 seconds. A real 2–3 second dip may go unseen because the controller visits multiple ESP-NOW channels and uses the latest received samples. Once the fan is on, a mean of exactly 700 ppm leaves it on; a mean strictly below 700 ppm switches it off.

ESP-NOW and Wi-Fi share the XIAO's one 2.4 GHz radio. A connected logger sends on its access point's channel; when offline it sends on its current radio channel. The controller has no Wi-Fi connection and cycles through channels permitted by its configured India radio domain, dwelling one second on each. This allows loggers connected to different AP channels to be heard over time, but reception is not guaranteed on every broadcast. The 60-second expiry bounds how long an old reading can affect control. Test channel coverage and packet ages at the actual installation. Keep the SCD30 measurement interval at or below 15 seconds for this version; the default is two seconds. Wi-Fi scans and roaming may interrupt a few broadcasts.

## Provisioning and upload

1. Open each new logger sketch in Arduino IDE and select **XIAO ESP32S3**. Its `private_config.h` already contains a local copy of that logger's existing device key and IITD username, plus a newly generated common ESP-NOW key. These four private files are git-ignored. Do not share or commit them. `private_config.example.h` is only a template.
2. Upload the three new logger sketches to their corresponding physical loggers. Confirm each prints `Fan ESP-NOW ready, station MAC:` in Serial Monitor and still logs to SD and checks in to the cloud as before.
3. Open and upload `fan_controller/fan_controller.ino` to the controller XIAO. It uses the same generated ESP-NOW key in its private config. The controller prints its channel range and pairs each logger ID to the **first correctly signed** station MAC it sees, then stores that MAC in NVS. The controller rejects a different MAC claiming the same logger ID. Flash the intended three loggers before commissioning the controller near other test devices using the same key.
4. With mains **disconnected**, verify the relay board's input polarity, input current, and motor-contact rating. The controller uses **D10/GPIO9**, the header pin directly below 3V3, to drive the relay `IN` terminal through an NPN transistor. The supplied sketch and [`fan_wiring.svg`](fan_wiring.svg) assume an **active-low** `IN` pin. The NPN keeps the XIAO's 3.3 V pin away from a possible 5 V pull-up on the relay module's input. A 4.7 kΩ base resistor and 100 kΩ base-to-ground resistor provide drive and a reset-off state. If the board has a different trigger circuit, adapt both driver and output polarity before connecting the fan. The JQC-3FC marking on the relay itself does **not** establish the module's 3.3 V logic compatibility or its motor duty rating.
5. Test with a disconnected low-voltage load or indicator first. Confirm serial status with zero, one, two, and three loggers; readings crossing the threshold; a logger power loss; all logger power loss; and controller reset. Only then have a qualified electrician verify and connect the 230 V side.

The controller does not have a cloud endpoint or Wi-Fi credentials; only the logger cloud behavior is retained. Replacing a logger with a different ESP32 station MAC requires clearing the **controller's** saved `fanPeers` NVS namespace and pairing again. Erasing the controller's flash/NVS using the Arduino upload tool is one way to do that; it does not alter logger data. Keep the shared key secret. A new key must be installed on all four devices together.

### Optional wireless localhost dashboard, without Wi-Fi

The controller advertises a read-only Bluetooth Low Energy device named **AQ-FAN**. It sends a 17-byte status notification every two seconds while a browser is connected. This does not join a Wi-Fi network or contact Supabase. The dashboard is a separate page on **your computer**, not on AQ Observatory. It makes **zero Supabase requests** and does not store measurements. The displayed ON/OFF value is the **relay command**; the controller has no contact or motor rotation feedback. USB serial output remains available for bench diagnostics but is not used by the dashboard.

1. Upload the updated `fan_controller.ino`. The three logger sketches do not need another upload for this dashboard or threshold change.
2. Put the computer within Bluetooth range of the powered controller and enable the computer's Bluetooth adapter. No cable between them is needed.
3. From `controller_local_dashboard`, double-click `start_dashboard.bat`, or run `python -m http.server 8765 --bind 127.0.0.1` in that folder. This only serves the page on the computer; it does not connect to the controller.
4. Open **http://localhost:8765** in desktop Chrome or Edge. Click **Show local dashboard** and select **AQ-FAN** in the Bluetooth picker. The fan command, spatial mean, three logger readings, freshness, and current ESP-NOW channel update about every two seconds.
5. Click **Hide local dashboard** to disconnect Bluetooth. The controller continues fan control without the computer or page. Stop the local server with Ctrl+C when finished.

Web Bluetooth requires a supported browser, Bluetooth adapter, a user click, and a secure context; `localhost` qualifies. The local server binds to `127.0.0.1`, so other computers cannot access it. The ESP32-S3 uses radio time sharing for BLE and ESP-NOW. Espressif lists ESP-NOW reception with BLE connected as supported in station mode, which this controller uses, but verify packet ages and fan behavior at the installation with the dashboard both open and closed. No radio link can prove that the motor is actually rotating.

### Can `IN` connect directly to D10?

The NPN is **not inherently required** if the _relay module input circuit_ is specified and tested for 3.3 V GPIO operation. The JQC-3FC label identifies the relay, not that input circuit. Direct wiring is acceptable only when the module accepts a 3.3 V HIGH as OFF, pulls no GPIO above 3.3 V, has a known active-LOW trigger, and stays OFF while D10 is high impedance during reset. For that verified case, connect `D10 → IN` and put `#define FAN_RELAY_DIRECT_ACTIVE_LOW 1` in the **controller's** `private_config.h`; the sketch then drives LOW for ON and HIGH for OFF. Do not leave the default transistor polarity selected for direct wiring. If those input details are unavailable, keep the NPN circuit in the diagram. Do not connect the relay coil itself directly to a GPIO.

## Mains assembly

Use a listed/certified isolated 5 V supply sized for the XIAO and relay module. Seeed requires a series diode when an external supply feeds the XIAO's 5V/VBUS pin; connect its **anode toward the supply** and **cathode toward the XIAO 5V pin**, as shown in the diagram. Provide suitable branch protection, an RCD where required, cable strain relief at the supply and fan entries, covered insulated neutral and earth terminals, and a closed enclosure with physical separation between mains and low-voltage wiring. Connect supply **L → protected relay COM → relay NO → fan L**. Connect **N → insulated connector → fan N**. Keep **PE continuous** to the fan and any metal enclosure that requires it. Never route mains onto the XIAO board or breadboard.

The fan is an inductive motor load with starting current above its running current. A printed resistive contact rating is insufficient evidence of motor suitability; use a relay/contactor and terminal assembly explicitly rated for the fan's 230 V AC motor starting and switching duty. If the particular JQC module lacks that rating, use it only as an appropriately designed control stage for a motor-rated contactor. An electrician must verify wire sizes, protection, earthing, isolation, enclosure, and the final circuit before energizing mains. The software's off state cannot detect welded contacts or substitute for a manual isolation switch.

## References

- [Seeed XIAO ESP32-S3 pin map and power guidance](https://wiki.seeedstudio.com/xiao_esp32s3_getting_started/): D10 is GPIO9; a diode is required for external power into 5V/VBUS.
- [Espressif ESP-NOW guide for ESP32-S3](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/network/esp_now.html): current-channel sending and broadcast behavior.
- [Espressif Wi-Fi API](https://docs.espressif.com/projects/esp-idf/en/v5.5.6/esp32s3/api-reference/network/esp_wifi.html): channel and country configuration.
- [Espressif ESP32-S3 coexistence guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/coexist.html): ESP-NOW reception and BLE connected coexist in station mode.
- [MDN Web Bluetooth API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API): browser support and permission requirements.
- [Omron relay safety precautions](https://www.ia.omron.com/product/cautions/36/safety_precautions.html): motor inrush and contact selection.
