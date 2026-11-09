#pragma once

// Included near the end of the copied logger sketch, after its sensor globals.
#include <esp_now.h>
#include <esp_wifi.h>
#include <mbedtls/md.h>
#include <stddef.h>
#include <string.h>

#ifndef FAN_ESPNOW_KEY
#define FAN_ESPNOW_KEY "SET_THE_SAME_RANDOM_32_BYTE_KEY_ON_ALL_FOUR_DEVICES"
#endif

#ifndef FAN_LOGGER_ID
#error FAN_LOGGER_ID must be defined by the logger sketch
#endif

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
static const uint8_t FAN_BROADCAST_MAC[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
static bool fanEspNowReady = false;
static uint32_t fanBootNonce = 0;
static uint32_t fanSequence = 0;
static unsigned long fanLastSendMs = 0;
static unsigned long fanLastInitAttemptMs = 0;

bool signFanPacket(FanEspNowPacket& packet) {
  const mbedtls_md_info_t* sha = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  if (!sha) return false;
  uint8_t digest[32];
  if (mbedtls_md_hmac(sha,
      reinterpret_cast<const unsigned char*>(FAN_ESPNOW_KEY), strlen(FAN_ESPNOW_KEY),
      reinterpret_cast<const unsigned char*>(&packet), offsetof(FanEspNowPacket, tag),
      digest) != 0) return false;
  memcpy(packet.tag, digest, sizeof(packet.tag));
  return true;
}

void startFanEspNow() {
  fanLastInitAttemptMs = millis();
  if (fanEspNowReady) return;
  if (strlen(FAN_ESPNOW_KEY) < 32 ||
      strcmp(FAN_ESPNOW_KEY, "SET_THE_SAME_RANDOM_32_BYTE_KEY_ON_ALL_FOUR_DEVICES") == 0) {
    Serial.println("Fan ESP-NOW disabled: set FAN_ESPNOW_KEY in private_config.h");
    return;
  }
  if (esp_now_init() != ESP_OK) {
    Serial.println("Fan ESP-NOW initialization failed; retrying later.");
    return;
  }
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, FAN_BROADCAST_MAC, sizeof(FAN_BROADCAST_MAC));
  peer.ifidx = WIFI_IF_STA;
  peer.channel = 0;  // Follow the logger's current Wi-Fi channel.
  peer.encrypt = false;  // Broadcast cannot use ESP-NOW link encryption; HMAC authenticates.
  if (esp_now_add_peer(&peer) != ESP_OK) {
    esp_now_deinit();
    Serial.println("Fan ESP-NOW broadcast peer failed; retrying later.");
    return;
  }
  fanBootNonce = esp_random();
  fanSequence = 0;
  fanEspNowReady = true;
  Serial.print("Fan ESP-NOW ready, station MAC: ");
  Serial.println(WiFi.macAddress());
}

void serviceFanEspNow() {
  const unsigned long now = millis();
  if (!fanEspNowReady) {
    if (now - fanLastInitAttemptMs >= 10000UL) startFanEspNow();
    return;
  }
  if (now - fanLastSendMs < 2000UL) return;
  fanLastSendMs = now;
  if (!scd30DataUsable(now)) return;
  const unsigned long age = now - lastScd30SampleMs;
  if (age > 15000UL || !isfinite(co2Concentration) ||
      co2Concentration < 1.0f || co2Concentration > 10000.0f) return;

  // Disconnected stations use channel 1 when the radio has no current channel.
  // A connected station always stays on its AP's channel.
  uint8_t primary = 0;
  wifi_second_chan_t secondary = WIFI_SECOND_CHAN_NONE;
  if (esp_wifi_get_channel(&primary, &secondary) == ESP_OK && primary == 0 &&
      WiFi.status() != WL_CONNECTED && wifiState == WIFI_IDLE) {
    esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  }

  FanEspNowPacket packet = {};
  packet.magic = 0x46414e31UL;  // FAN1
  packet.version = 1;
  packet.loggerId = FAN_LOGGER_ID;
  packet.co2Ppm = static_cast<uint16_t>(co2Concentration + 0.5f);
  packet.bootNonce = fanBootNonce;
  packet.sequence = ++fanSequence;
  packet.sensorAgeMs = age;
  if (!signFanPacket(packet)) return;
  if (esp_now_send(FAN_BROADCAST_MAC, reinterpret_cast<const uint8_t*>(&packet),
                   sizeof(packet)) != ESP_OK) {
    // Wi-Fi scans and reconnects can temporarily move the radio off-channel.
    // The next sensor broadcast retries without interrupting SD/cloud work.
    static unsigned long lastWarningMs = 0;
    if (now - lastWarningMs >= 30000UL) {
      lastWarningMs = now;
      Serial.println("Fan ESP-NOW send deferred by radio; retrying.");
    }
  }
}
