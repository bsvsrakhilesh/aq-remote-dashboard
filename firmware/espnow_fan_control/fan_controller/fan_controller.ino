#include <Arduino.h>
#include <WiFi.h>
#include <Preferences.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <atomic>
#include <stddef.h>
#include <string.h>

#if __has_include("private_config.h")
#include "private_config.h"
#endif
#ifndef FAN_ESPNOW_KEY
#define FAN_ESPNOW_KEY "SET_THE_SAME_RANDOM_32_BYTE_KEY_ON_ALL_FOUR_DEVICES"
#endif

// D10/GPIO9, directly below the 3V3 pin, drives the base of an NPN transistor.
// HIGH sinks the verified active-LOW relay module IN terminal. An external
// base pulldown holds OFF during reset and while the pin is high impedance.
// Direct D10 -> IN requires a verified 3.3 V-compatible active-LOW module,
// a reset-OFF input, and FAN_RELAY_DIRECT_ACTIVE_LOW=1 in private_config.h.
#ifndef FAN_RELAY_DIRECT_ACTIVE_LOW
#define FAN_RELAY_DIRECT_ACTIVE_LOW 0
#endif
static_assert(FAN_RELAY_DIRECT_ACTIVE_LOW == 0 || FAN_RELAY_DIRECT_ACTIVE_LOW == 1,
              "FAN_RELAY_DIRECT_ACTIVE_LOW must be 0 or 1");
constexpr int RELAY_DRIVER_PIN = D10;
constexpr uint32_t ON_THRESHOLD_PPM = 700;
constexpr uint32_t OFF_THRESHOLD_PPM = 700;
constexpr uint32_t ON_HOLD_MS = 30000;
constexpr uint32_t READING_TTL_MS = 60000;
constexpr uint32_t CHANNEL_DWELL_MS = 1000;
// Custom read-only BLE service. The 17-byte packet fits the default GATT MTU.
constexpr const char* LOCAL_BLE_SERVICE_UUID = "33a0b0a9-e3bd-4c03-9789-005a94e37647";
constexpr const char* LOCAL_BLE_STATUS_UUID = "fe47cbad-6901-413c-8cf4-8b17d81f967c";

struct __attribute__((packed)) FanEspNowPacket {
  uint32_t magic;
  uint8_t version;
  uint8_t loggerId;
  uint16_t co2Ppm;
  uint32_t bootNonce;
  uint32_t sequence;
  uint32_t sensorAgeMs;
  uint8_t tag[16];
};
static_assert(sizeof(FanEspNowPacket) == 36, "ESP-NOW packet layout changed");

struct ReceivedPacket {
  uint8_t mac[6];
  FanEspNowPacket packet;
};

struct LoggerState {
  bool paired = false;
  bool seen = false;
  uint8_t mac[6] = {};
  uint32_t bootNonce = 0;
  uint32_t sequence = 0;
  uint16_t co2Ppm = 0;
  uint32_t sensorAgeMs = 0;
  uint32_t receivedAtMs = 0;
};

LoggerState loggers[3];
Preferences peerPrefs;
QueueHandle_t receiveQueue = nullptr;
bool radioReady = false;
bool fanOn = false;
bool highPending = false;
uint32_t highSinceMs = 0;
uint32_t lastRadioAttemptMs = 0;
uint32_t lastHopMs = 0;
uint32_t lastStatusMs = 0;
uint8_t channelMin = 1;
uint8_t channelMax = 11;
uint8_t channel = 1;
BLECharacteristic* localBleStatus = nullptr;
std::atomic<bool> bleConnected{false};

class LocalBleServerCallbacks : public BLEServerCallbacks {
 public:
  void onConnect(BLEServer*) override { bleConnected.store(true); }
  void onDisconnect(BLEServer*) override { bleConnected.store(false); }
};

void startLocalBle() {
  BLEDevice::init("AQ-FAN");
  BLEServer* server = BLEDevice::createServer();
  if (!server) {
    Serial.println("Local BLE server unavailable; fan control continues.");
    return;
  }
  server->setCallbacks(new LocalBleServerCallbacks());
  BLEService* service = server->createService(LOCAL_BLE_SERVICE_UUID);
  if (!service) {
    Serial.println("Local BLE service unavailable; fan control continues.");
    return;
  }
  localBleStatus = service->createCharacteristic(
      LOCAL_BLE_STATUS_UUID,
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  if (!localBleStatus) {
    Serial.println("Local BLE characteristic unavailable; fan control continues.");
    return;
  }
  localBleStatus->addDescriptor(new BLE2902());
  uint8_t initial[17] = {1, 0, 0, 0, 0xff, 0xff, 0xff, 0xff, 0xff,
                         0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
  localBleStatus->setValue(initial, sizeof(initial));
  service->start();
  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(LOCAL_BLE_SERVICE_UUID);
  advertising->setScanResponse(true);
  BLEDevice::startAdvertising();
  Serial.println("Local BLE dashboard advertising as AQ-FAN.");
}

void putLe16(uint8_t* packet, size_t index, uint16_t value) {
  packet[index] = static_cast<uint8_t>(value);
  packet[index + 1] = static_cast<uint8_t>(value >> 8);
}

void setFan(bool on) {
  if (fanOn == on) return;
  digitalWrite(RELAY_DRIVER_PIN,
               FAN_RELAY_DIRECT_ACTIVE_LOW ? (on ? LOW : HIGH) : (on ? HIGH : LOW));
  fanOn = on;
  Serial.println(on ? "FAN ON" : "FAN OFF");
}

bool validKey() {
  return strlen(FAN_ESPNOW_KEY) >= 32 &&
         strcmp(FAN_ESPNOW_KEY,
                "SET_THE_SAME_RANDOM_32_BYTE_KEY_ON_ALL_FOUR_DEVICES") != 0;
}

bool authenticPacket(const FanEspNowPacket& packet) {
  const mbedtls_md_info_t* sha = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!sha) return false;
  uint8_t digest[32];
  if (mbedtls_md_hmac(sha,
      reinterpret_cast<const unsigned char*>(FAN_ESPNOW_KEY), strlen(FAN_ESPNOW_KEY),
      reinterpret_cast<const unsigned char*>(&packet), offsetof(FanEspNowPacket, tag),
      digest) != 0) return false;
  uint8_t mismatch = 0;
  for (size_t i = 0; i < sizeof(packet.tag); ++i) mismatch |= digest[i] ^ packet.tag[i];
  return mismatch == 0;
}

void onFanPacket(const esp_now_recv_info_t* info, const uint8_t* data, int len) {
  if (!receiveQueue || !info || !info->src_addr || !data ||
      len != static_cast<int>(sizeof(FanEspNowPacket))) return;
  ReceivedPacket item = {};
  memcpy(item.mac, info->src_addr, sizeof(item.mac));
  memcpy(&item.packet, data, sizeof(item.packet));
  // The Wi-Fi callback does no HMAC, flash I/O, or relay switching.
  xQueueSend(receiveQueue, &item, 0);
}

void printMac(const uint8_t mac[6]) {
  for (int i = 0; i < 6; ++i) {
    if (i) Serial.print(':');
    if (mac[i] < 16) Serial.print('0');
    Serial.print(mac[i], HEX);
  }
}

void loadPairs() {
  peerPrefs.begin("fanPeers", false);
  for (int i = 0; i < 3; ++i) {
    char key[8];
    snprintf(key, sizeof(key), "mac%d", i + 1);
    if (peerPrefs.getBytesLength(key) == 6 &&
        peerPrefs.getBytes(key, loggers[i].mac, 6) == 6) {
      loggers[i].paired = true;
      Serial.printf("Logger %d paired to ", i + 1);
      printMac(loggers[i].mac);
      Serial.println();
    }
  }
}

void processPacket(const ReceivedPacket& item) {
  const FanEspNowPacket& p = item.packet;
  if (p.magic != 0x46414e31UL || p.version != 1 || p.loggerId < 1 ||
      p.loggerId > 3 || p.co2Ppm < 1 || p.co2Ppm > 10000 ||
      p.sensorAgeMs > 15000 || p.sequence == 0 || !authenticPacket(p)) return;

  LoggerState& state = loggers[p.loggerId - 1];
  if (state.paired && memcmp(state.mac, item.mac, 6) != 0) return;
  if (state.seen && state.bootNonce == p.bootNonce && p.sequence <= state.sequence) return;

  if (!state.paired) {
    char key[8];
    snprintf(key, sizeof(key), "mac%d", p.loggerId);
    if (peerPrefs.putBytes(key, item.mac, 6) != 6) {
      Serial.println("Could not save logger pairing; packet ignored.");
      return;
    }
    memcpy(state.mac, item.mac, 6);
    state.paired = true;
    Serial.printf("Paired logger %d to ", p.loggerId);
    printMac(item.mac);
    Serial.println();
  }

  state.bootNonce = p.bootNonce;
  state.sequence = p.sequence;
  state.co2Ppm = p.co2Ppm;
  state.sensorAgeMs = p.sensorAgeMs;
  state.receivedAtMs = millis();
  state.seen = true;
}

bool startRadio() {
  lastRadioAttemptMs = millis();
  if (!validKey()) {
    Serial.println("Fan disabled: set FAN_ESPNOW_KEY in private_config.h");
    return false;
  }
  WiFi.mode(WIFI_STA);  // Radio only; no SSID, IP, router, or Internet needed.
  WiFi.setSleep(false);
  if (esp_wifi_set_country_code("IN", false) != ESP_OK) {
    Serial.println("Could not set IN radio domain; using driver country limits.");
  }
  wifi_country_t country = {};
  if (esp_wifi_get_country(&country) == ESP_OK && country.nchan > 0) {
    channelMin = country.schan > 1 ? country.schan : 1;
    uint8_t last = country.schan + country.nchan - 1;
    channelMax = last < 13 ? last : 13;
    if (channelMin > channelMax) {
      channelMin = 1;
      channelMax = 11;
    }
  }
  channel = channelMin;
  if (esp_wifi_set_channel(channel, WIFI_SECOND_CHAN_NONE) != ESP_OK) {
    Serial.println("Could not set ESP-NOW receive channel.");
    return false;
  }
  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW receiver initialization failed.");
    return false;
  }
  if (esp_now_register_recv_cb(onFanPacket) != ESP_OK) {
    esp_now_deinit();
    Serial.println("ESP-NOW receiver initialization failed.");
    return false;
  }
  lastHopMs = millis();
  Serial.printf("ESP-NOW listening on channels %u..%u; controller MAC %s\n",
                channelMin, channelMax, WiFi.macAddress().c_str());
  return true;
}

void serviceRadio(uint32_t now) {
  if (!radioReady) {
    setFan(false);
    highPending = false;
    if (now - lastRadioAttemptMs >= 10000UL) radioReady = startRadio();
    return;
  }
  if (now - lastHopMs < CHANNEL_DWELL_MS) return;
  uint8_t next = channel >= channelMax ? channelMin : channel + 1;
  if (esp_wifi_set_channel(next, WIFI_SECOND_CHAN_NONE) == ESP_OK) {
    channel = next;
  }
  lastHopMs = now;
}

void evaluateFan(uint32_t now) {
  uint32_t total = 0;
  uint8_t count = 0;
  for (const LoggerState& state : loggers) {
    if (!state.seen) continue;
    uint32_t age = now - state.receivedAtMs + state.sensorAgeMs;
    if (age > READING_TTL_MS) continue;
    total += state.co2Ppm;
    ++count;
  }

  if (count == 0) {
    highPending = false;
    setFan(false);  // No valid measurements: safe output state.
  } else if (fanOn) {
    if (total < OFF_THRESHOLD_PPM * count) setFan(false);
  } else if (total > ON_THRESHOLD_PPM * count) {
    if (!highPending) {
      highPending = true;
      highSinceMs = now;
    } else if (now - highSinceMs >= ON_HOLD_MS) {
      setFan(true);
      highPending = false;
    }
  } else {
    highPending = false;
  }

  if (now - lastStatusMs >= 10000UL) {
    lastStatusMs = now;
    Serial.printf("Valid loggers: %u/3, mean: ", count);
    if (count) Serial.print(static_cast<float>(total) / count, 1);
    else Serial.print("unavailable");
    Serial.printf(" ppm, fan: %s, channel: %u\n", fanOn ? "ON" : "OFF", channel);
  }
}

// Optional USB serial diagnostics. The localhost dashboard uses BLE; no Wi-Fi,
// cloud request, or browser command is involved in the control decision.
void publishLocalStatus(uint32_t now) {
  static uint32_t lastPublishMs = 0;
  if (now - lastPublishMs < 2000UL) return;
  lastPublishMs = now;
  if (!Serial) return;  // Avoid diagnostic frames with no USB listener.

  uint32_t total = 0;
  uint8_t count = 0;
  for (const LoggerState& state : loggers) {
    if (state.seen && now - state.receivedAtMs + state.sensorAgeMs <= READING_TTL_MS) {
      total += state.co2Ppm;
      ++count;
    }
  }

  Serial.print("AQFAN_STATUS {\"v\":1,\"uptime_ms\":");
  Serial.print(now);
  Serial.print(",\"fan_on\":");
  Serial.print(fanOn ? "true" : "false");
  Serial.print(",\"radio_ready\":");
  Serial.print(radioReady ? "true" : "false");
  Serial.print(",\"channel\":");
  if (radioReady) Serial.print(channel);
  else Serial.print("null");
  Serial.print(",\"valid_loggers\":");
  Serial.print(count);
  Serial.print(",\"mean_co2_ppm\":");
  if (count) Serial.print(static_cast<float>(total) / count, 1);
  else Serial.print("null");
  Serial.print(",\"on_hold_remaining_ms\":");
  if (highPending && !fanOn) {
    const uint32_t elapsed = now - highSinceMs;
    Serial.print(elapsed >= ON_HOLD_MS ? 0 : ON_HOLD_MS - elapsed);
  } else {
    Serial.print("null");
  }
  Serial.print(",\"loggers\":[");
  for (int i = 0; i < 3; ++i) {
    if (i) Serial.print(',');
    const LoggerState& state = loggers[i];
    Serial.print("{\"id\":");
    Serial.print(i + 1);
    Serial.print(",\"co2_ppm\":");
    if (state.seen) Serial.print(state.co2Ppm);
    else Serial.print("null");
    Serial.print(",\"age_ms\":");
    uint32_t age = 0;
    if (state.seen) {
      age = now - state.receivedAtMs + state.sensorAgeMs;
      Serial.print(age);
    } else {
      Serial.print("null");
    }
    Serial.print(",\"fresh\":");
    Serial.print(state.seen && age <= READING_TTL_MS ? "true" : "false");
    Serial.print('}');
  }
  Serial.println("]}");
}

// Byte layout (little-endian): version, flags, channel, valid count,
// mean ppm, three logger ppm values, three sample ages in seconds,
// and fan-on hold remaining in seconds. 0xffff/0xff means unavailable.
void publishBleStatus(uint32_t now) {
  if (!localBleStatus) return;
  static uint32_t lastPublishMs = 0;
  static bool wasConnected = false;
  static uint32_t disconnectedAtMs = 0;
  const bool connected = bleConnected.load();
  if (!connected && wasConnected) disconnectedAtMs = now;
  if (!connected && disconnectedAtMs && now - disconnectedAtMs >= 500UL) {
    BLEDevice::startAdvertising();
    disconnectedAtMs = 0;
  }
  wasConnected = connected;
  if (now - lastPublishMs < 2000UL) return;
  lastPublishMs = now;

  uint8_t packet[17] = {};
  packet[0] = 1;
  packet[1] = (fanOn ? 1 : 0) | (radioReady ? 2 : 0);
  packet[2] = radioReady ? channel : 0;
  uint32_t total = 0;
  uint8_t count = 0;
  for (int i = 0; i < 3; ++i) {
    const LoggerState& state = loggers[i];
    uint32_t ageMs = state.seen ? now - state.receivedAtMs + state.sensorAgeMs : 0;
    putLe16(packet, 6 + 2 * i, state.seen ? state.co2Ppm : 0xffff);
    packet[12 + i] = state.seen
        ? static_cast<uint8_t>(ageMs > 254000UL ? 254 : (ageMs + 999UL) / 1000UL)
        : 0xff;
    if (state.seen && ageMs <= READING_TTL_MS) {
      total += state.co2Ppm;
      ++count;
    }
  }
  packet[3] = count;
  putLe16(packet, 4, count ? static_cast<uint16_t>((total + count / 2) / count) : 0xffff);
  uint16_t holdSeconds = 0xffff;
  if (highPending && !fanOn) {
    const uint32_t elapsed = now - highSinceMs;
    holdSeconds = elapsed >= ON_HOLD_MS ? 0 :
        static_cast<uint16_t>((ON_HOLD_MS - elapsed + 999UL) / 1000UL);
  }
  putLe16(packet, 15, holdSeconds);
  localBleStatus->setValue(packet, sizeof(packet));
  if (connected) localBleStatus->notify();
}

void setup() {
  digitalWrite(RELAY_DRIVER_PIN, FAN_RELAY_DIRECT_ACTIVE_LOW ? HIGH : LOW);
  pinMode(RELAY_DRIVER_PIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("CO2 fan controller starting. Relay driver OFF.");
  receiveQueue = xQueueCreate(24, sizeof(ReceivedPacket));
  if (!receiveQueue) {
    Serial.println("Receive queue allocation failed. Fan remains OFF.");
    return;
  }
  loadPairs();
  radioReady = startRadio();
  startLocalBle();
}

void loop() {
  const uint32_t now = millis();
  serviceRadio(now);
  if (radioReady && receiveQueue) {
    ReceivedPacket item;
    while (xQueueReceive(receiveQueue, &item, 0) == pdTRUE) processPacket(item);
  }
  evaluateFan(now);
  publishLocalStatus(now);
  publishBleStatus(now);
  delay(10);
}
