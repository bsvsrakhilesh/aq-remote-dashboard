/***************************************************************
 * Includes
 ***************************************************************/
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <RTClib.h>
#include <sps30.h>
#include <FS.h>
#include <SD.h>
#include <WiFi.h>
#include <NetworkClientSecure.h>
#include <HTTPClient.h>
#include "esp_eap_client.h"
#include "esp_err.h"
#include <sys/time.h>
#include <esp_sntp.h>
#include <atomic>
#include <Preferences.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <SensirionI2cSht3x.h>
#include <time.h>
#include <math.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/semphr.h>

// Copy private_config.example.h to private_config.h and fill it locally.
// private_config.h is git-ignored so device credentials stay off GitHub.
#if __has_include("private_config.h")
#include "private_config.h"
#endif
#ifndef OUTDOOR_DEVICE_SECRET
#define OUTDOOR_DEVICE_SECRET "YOUR_DEVICE_SECRET"
#endif
#ifndef OUTDOOR_IITD_USERNAME
#define OUTDOOR_IITD_USERNAME "YOUR_IITD_USERNAME"
#endif
#include <esp_timer.h>

// Serialize sensor/RTC snapshots, shared status and SD access. Never hold this
// mutex across a cloud HTTP/TLS operation; acquisition must remain independent.
SemaphoreHandle_t loggerStateMutex = nullptr;
class LoggerStateLock {
 public:
  LoggerStateLock() { if (loggerStateMutex) { xSemaphoreTakeRecursive(loggerStateMutex, portMAX_DELAY); held = true; } }
  ~LoggerStateLock() { unlock(); }
  void unlock() { if (held) { xSemaphoreGiveRecursive(loggerStateMutex); held = false; } }
 private:
  bool held = false;
};

/***************************************************************
 * Hardware configuration
 ***************************************************************/
#define SCREEN_WIDTH  128
#define SCREEN_HEIGHT 64

// Shared I2C bus: XIAO Expansion Board onboard OLED + SHT3x + SPS30 + DS3231
#define I2C_SDA      D4
#define I2C_SCL      D5
#define OLED_RESET   -1
#define OLED_ADDRESS 0x3C

// XIAO Expansion Board onboard microSD (SPI)
// Expansion-board SD CS is hard-wired to D2.
#define SD_CS_PIN   D2
#define SD_MOSI     D10
#define SD_MISO     D9
#define SD_SCK      D8
const uint32_t SD_SPI_FREQUENCY_HZ = 15000000UL;

// Passive buzzer built into the Seeed XIAO Expansion Board.
// On the expansion board it is connected to A3 / D3.
#define BUZZER_PIN D3
const uint16_t BUZZER_FREQUENCY_HZ = 2700;

// Permanent friendly name for this logger.
// Device code also prefixes each SD CSV. mDNS uses a DNS-safe hyphenated name.
// DHCP may change the numeric IP; open http://aq-outdoor01.local instead.
const char* DEVICE_HOSTNAME = "aq_outdoor01";
const char* NETWORK_HOSTNAME = "aq-outdoor01";

// Firmware identifier shown in the remote dashboard heartbeat.
const char* FIRMWARE_VERSION = "pm-sht-iitd-cloud-1.2.1";

// -----------------------------------------------------------------------------
// IIT Delhi WPA2-Enterprise / PEAP configuration
// -----------------------------------------------------------------------------
// Set the username in private_config.h. Do not paste your Kerberos password
// into source code. The existing Serial Wi-Fi flow asks for
// the password and stores it in ESP32 Preferences after a successful connection.
const char* IITD_WIFI_SSID = "IITD_WIFI";
const char* IITD_EAP_IDENTITY = OUTDOOR_IITD_USERNAME;
const char* IITD_EAP_USERNAME = OUTDOOR_IITD_USERNAME;

// -----------------------------------------------------------------------------
// Remote dashboard / Supabase Edge Functions configuration
// -----------------------------------------------------------------------------
// The logger keeps working normally when these values are left as placeholders.
// Fill them after your dashboard backend is deployed. GitHub Pages itself is only
// the frontend; these URLs point to the backend functions used by the dashboard.
const char* CLOUD_FUNCTIONS_BASE =
    "https://qnrfwfuyxuzqdcbgrwdd.supabase.co/functions/v1";
const char* CLOUD_DEVICE_ID = "aq_outdoor01";
const char* CLOUD_DEVICE_SECRET = OUTDOOR_DEVICE_SECRET;

bool mdnsStarted = false;

RTC_DS3231 rtc;


// Weekly SD log rotation: Monday -> Sunday.
// Old weekly files are preserved and never overwritten.
// Example:
// aq_outdoor01_2026-09-14_to_2026-09-20.csv

String formatDateForFilename(const DateTime& dt) {
  char b[11];
  snprintf(b, sizeof(b), "%04d-%02d-%02d",
           dt.year(), dt.month(), dt.day());
  return String(b);
}

DateTime startOfWeekMonday(const DateTime& now) {
  // RTClib: Sunday=0, Monday=1, ... Saturday=6
  uint8_t dow = now.dayOfTheWeek();
  uint8_t daysSinceMonday = (dow == 0) ? 6 : (dow - 1);

  uint32_t startEpoch =
      now.unixtime() - (uint32_t)daysSinceMonday * 86400UL;

  DateTime s(startEpoch);
  return DateTime(
      s.year(), s.month(), s.day(),
      0, 0, 0);
}

DateTime endOfWeekSunday(const DateTime& now) {
  DateTime start = startOfWeekMonday(now);
  return DateTime(start.unixtime() + 6UL * 86400UL);
}

uint32_t bootSequence = 0;
uint32_t bootNonce = 0;
bool getTrustedLogTime(DateTime& dateTime);

String getRecoveryLogFilePath() {
  char nonce[9];
  snprintf(nonce, sizeof(nonce), "%08lx", static_cast<unsigned long>(bootNonce));
  return "/" + String(DEVICE_HOSTNAME) + "_unsynced_" +
         String(bootSequence) + "_" + nonce + ".csv";
}

String getWeeklyLogFilePath(const DateTime& now) {
  DateTime ws = startOfWeekMonday(now);
  DateTime we = endOfWeekSunday(now);

  return "/" + String(DEVICE_HOSTNAME) + "_" +
         formatDateForFilename(ws) + "_to_" +
         formatDateForFilename(we) + ".csv";
}

String getLogFilePath() {
  DateTime now;
  return getTrustedLogTime(now) ? getWeeklyLogFilePath(now)
                                : getRecoveryLogFilePath();
}

String getLogDownloadName() {
  String p = getLogFilePath();
  if (p.startsWith("/")) p.remove(0, 1);
  return p;
}


// Weekly SD filenames follow the permanent logger hostname and RTC date range.
// Audible startup status:
//   1 beep  = firmware has started.
//   2 beeps = first CSV row has actually been written successfully to SD.
bool firstSuccessfulLogBeepDone = false;


Adafruit_SSD1306 display(
    SCREEN_WIDTH,
    SCREEN_HEIGHT,
    &Wire,
    OLED_RESET);

File logFile;


/***************************************************************
 * Buzzer helpers
 ***************************************************************/
void buzzerBeep(uint16_t durationMs = 160) {
  tone(BUZZER_PIN, BUZZER_FREQUENCY_HZ);
  delay(durationMs);
  noTone(BUZZER_PIN);
}

void buzzerStartupBeep() {
  buzzerBeep(180);
}

void buzzerLoggingReadyDoubleBeep() {
  buzzerBeep(140);
  delay(120);
  buzzerBeep(140);
}

/***************************************************************
 * Timing configuration
 ***************************************************************/
// OLED page durations (ms)
unsigned long PM_PAGE_INTERVAL    = 3000UL;
unsigned long NC_PAGE_INTERVAL    = 3000UL;
unsigned long SHT3X_PAGE_INTERVAL = 6000UL;
unsigned long IP_PAGE_INTERVAL    = 3000UL;

// Sensor + logging intervals (ms)
unsigned long SPS30_READ_INTERVAL = 2000UL;
unsigned long SHT3X_READ_INTERVAL = 2000UL;
unsigned long LOG_INTERVAL        = 2000UL;

// OLED itself only needs to redraw once per second.
const unsigned long OLED_REFRESH_INTERVAL = 1000UL;

// SHT3x is read in single-shot mode; it has no internal periodic interval.
const unsigned long SHT3X_MIN_INTERVAL_MS = 1000UL;
const unsigned long SHT3X_MAX_INTERVAL_MS = 3600000UL;

// Practical validation limits for the web UI.
const unsigned long DISPLAY_MIN_INTERVAL_MS = 500UL;
const unsigned long SPS30_MIN_INTERVAL_MS   = 1000UL;
const unsigned long LOG_MIN_INTERVAL_MS     = 1000UL;

// Readiness is polled independently from the user-selected sampling cadence.
// This prevents missing a sample simply because the firmware checked a few
// milliseconds before the sensor asserted its data-ready flag.
const unsigned long SENSOR_READY_POLL_INTERVAL_MS = 100UL;

// A value is considered genuinely stale only after several expected sample
// periods have passed. This scales automatically when sampling intervals are
// changed from the web UI.
const unsigned long SENSOR_STALE_MIN_MS = 5000UL;
const unsigned long SENSOR_STALE_MARGIN_MS = 1000UL;

/***************************************************************
 * NTP / RTC configuration
 ***************************************************************/
// India Standard Time. Change this constant if the logger is used elsewhere.
const long NTP_UTC_OFFSET_SECONDS = 5L * 3600L + 30L * 60L;
const int  NTP_DST_OFFSET_SECONDS = 0;
const char* NTP_SERVER_1 = "pool.ntp.org";
const char* NTP_SERVER_2 = "time.nist.gov";

bool ntpSyncPending = false;
unsigned long ntpSyncStartMs = 0;
unsigned long lastNtpAttemptMs = 0;
unsigned long lastSuccessfulNtpMs = 0;
bool ntpSyncedSinceWifiConnect = false;
const unsigned long NTP_SYNC_TIMEOUT_MS = 20000UL;
const uint32_t NTP_SYNC_INTERVAL_MS = 6UL * 60UL * 60UL * 1000UL;
const unsigned long NTP_RETRY_INTERVAL_MS = 10UL * 60UL * 1000UL;
const unsigned long NTP_EVENT_MAX_AGE_MS = 60000UL;

// The SNTP callback runs on a networking task. Keep it free of I2C/flash work;
// transfer only its verified UTC timestamp to the logger loop.
std::atomic<uint32_t> ntpEventVersion{0};
std::atomic<uint32_t> ntpEventUtcSeconds{0};
std::atomic<uint32_t> ntpEventMillis{0};
uint32_t lastHandledNtpEventVersion = 0;

/***************************************************************
 * Display state
 ***************************************************************/
enum DisplayState {
  SHOW_PM = 0,
  SHOW_NC,
  SHOW_SHT3x,
  SHOW_IP
};

DisplayState currentDisplay = SHOW_PM;
unsigned long lastPageToggleMs = 0;
unsigned long lastOledRefreshMs = 0;
bool displayNeedsRefresh = true;

// Normal measurement pages start only after setup checks are complete.
bool startupComplete = false;

/***************************************************************
 * Preferences
 ***************************************************************/
Preferences wifiPrefs;
Preferences intervalPrefs;
Preferences rtcPreferences;

// A new namespace prevents old interval values from the previous firmware
// from silently overriding the corrected 3/3/6/3 s + 2/2/2 s defaults.
// Isolate SHT3x preferences from the SCD30 logger's interval settings.
const char* INTERVAL_PREF_NAMESPACE = "intervalsV3";

/***************************************************************
 * Wi-Fi + web server
 ***************************************************************/
WebServer server(80);

const int MAX_NETWORKS = 50;
String ssidList[MAX_NETWORKS];
int numNetworks = 0;

bool connected = false;
bool webServerStarted = false;

const unsigned long WIFI_CONNECT_TIMEOUT_MS = 45000UL;
const unsigned long WIFI_SCAN_RETRY_MS = 15000UL;
const unsigned long WIFI_PROVISION_TIMEOUT_MS = 120000UL;
const uint64_t WIFI_FAST_RETRY_MS = 5ULL * 60ULL * 1000ULL;
const uint64_t WIFI_SLOW_RETRY_MS = 30ULL * 60ULL * 1000ULL;
const int MAX_SAVED_WIFI_NETWORKS = 5;

String savedWifiSSIDs[MAX_SAVED_WIFI_NETWORKS];
String savedWifiPasswords[MAX_SAVED_WIFI_NETWORKS];
int savedWifiCount = 0;
int preferredWifiIndex = 0;
int currentKnownWifiIndex = -1;
int nextKnownWifiOffset = 0;
bool wifiOutageActive = false;
bool wifiRetryCycleActive = false;
bool manualWifiProvisioning = false;
bool wifiScanRequested = false;
uint64_t wifiOutageStartMs = 0;
uint64_t wifiNextRetryDueMs = 0;
uint32_t wifiRetryCycleNumber = 0;
unsigned long manualWifiStartMs = 0;

enum WifiState {
  WIFI_IDLE = 0,
  WIFI_SCANNING,
  WIFI_WAIT_SELECTION,
  WIFI_WAIT_PASSWORD,
  WIFI_CONNECTING
};

WifiState wifiState = WIFI_IDLE;
String pendingSSID;
String pendingPassword;
bool savePendingCredentials = false;
unsigned long wifiConnectStartMs = 0;
unsigned long lastWifiScanAttemptMs = 0;

/***************************************************************
 * Remote cloud dashboard state
 ***************************************************************/
const unsigned long CLOUD_HEARTBEAT_INTERVAL_MS = 60000UL;   // 1 minute
const unsigned long CLOUD_TELEMETRY_INTERVAL_MS = 300000UL;  // 5 minutes
const unsigned long CLOUD_COMMAND_POLL_INTERVAL_MS = 5000UL; // 5 seconds
const uint32_t CLOUD_HTTP_TIMEOUT_MS = 3000UL;

unsigned long lastCloudHeartbeatMs = 0;
unsigned long lastCloudTelemetryMs = 0;
unsigned long lastCloudCommandPollMs = 0;
unsigned long lastCloudSuccessMs = 0;
int lastCloudHttpCode = 0;
String cloudHealth = "NOT CONFIGURED";
String cloudLastAction = "--";
uint64_t currentLogFileSizeBytes = 0;

// Remote CSV uploads are streamed a small chunk at a time from the SD card so
// the complete file is never loaded into ESP32 RAM. The upload is serviced from
// a background task; only individual SD operations hold the shared mutex.
enum RemoteUploadState {
  REMOTE_UPLOAD_IDLE = 0,
  REMOTE_UPLOAD_SENDING,
  REMOTE_UPLOAD_WAIT_RESPONSE
};

RemoteUploadState remoteUploadState = REMOTE_UPLOAD_IDLE;
NetworkClientSecure remoteUploadClient;
File remoteUploadFile;
String remoteUploadCommandId;
String remoteUploadRequestId;
String remoteUploadFilename;
String remoteUploadMethod = "PUT";
String remoteUploadHost;
String remoteUploadPath;
uint16_t remoteUploadPort = 443;
uint64_t remoteUploadTotalBytes = 0;
uint64_t remoteUploadSentBytes = 0;
unsigned long remoteUploadLastActivityMs = 0;
int remoteUploadHttpCode = 0;
uint8_t remoteUploadLastProgressBucket = 255;
const unsigned long REMOTE_UPLOAD_STALL_TIMEOUT_MS = 30000UL;
const size_t REMOTE_UPLOAD_CHUNK_BYTES = 2048;

/***************************************************************
 * Sensor data
 ***************************************************************/
static struct sps30_measurement measurement;

SensirionI2cSht3x sht3x;
const uint8_t SHT3X_I2C_ADDRESS = 0x44;  // use 0x45 when ADDR is tied high
float temperature      = NAN;
float humidity         = NAN;
int16_t sht3xError     = 0;
char sht3xErrorMsg[128];

bool sps30HasValidData = false;
bool sht3xHasValidData = false;

/***************************************************************
 * Component health / diagnostics
 ***************************************************************/
bool displayOk = false;
bool rtcOk = false;
bool rtcTimeTrusted = false;
bool timeAnchorTrusted = false;
uint32_t timeAnchorLocalEpoch = 0;
uint64_t timeAnchorUptimeMs = 0;
bool unsyncedAwaitingAnchor = false;
unsigned long lastRtcCheckpointMs = 0;
unsigned long lastRtcPowerCheckMs = 0;
unsigned long lastMissingSensorWarningMs = 0;
const unsigned long RTC_CHECKPOINT_INTERVAL_MS = 10UL * 60UL * 1000UL;
const unsigned long RTC_POWER_CHECK_INTERVAL_MS = 60UL * 1000UL;
bool sps30Initialized = false;
bool sht3xInitialized = false;
bool sdReady = false;
bool sdLastWriteOk = false;
unsigned long lastSuccessfulSdWriteMs = 0;
unsigned long lastRecoveryAttemptMs = 0;
const unsigned long COMPONENT_RECOVERY_INTERVAL_MS = 5000UL;

String rtcHealth = "NOT CHECKED";
String sps30Health = "NOT CHECKED";
String sht3xHealth = "NOT CHECKED";
String sdHealth = "NOT CHECKED";

// Poll timers are intentionally separate from sample timestamps.
// The firmware can therefore check data-ready frequently without changing the
// user-selected SPS30/SHT3x sampling interval.
unsigned long lastSps30PollMs = 0;
unsigned long lastSht3xPollMs = 0;
unsigned long lastSps30SampleMs = 0;
unsigned long lastSht3xSampleMs = 0;
unsigned long lastLogMs = 0;

const char* WEEKLY_CSV_HEADER =
    "Date,Time,MC1.0,MC2.5,MC4.0,MC10.0,NC0.5,NC1.0,NC2.5,NC4.0,NC10.0,ParticleSize,Temp_C,Humidity_RH_percent";
const char* RECOVERY_CSV_HEADER =
    "Record,UptimeMs,Date,Time,MC1.0,MC2.5,MC4.0,MC10.0,NC0.5,NC1.0,NC2.5,NC4.0,NC10.0,ParticleSize,Temp_C,Humidity_RH_percent";

bool validLoggerTime(const DateTime& candidate) {
  return candidate.isValid() && candidate.year() >= 2024 && candidate.year() <= 2099;
}

void setTrustedTimeAnchor(const DateTime& localTime) {
  if (!validLoggerTime(localTime)) return;
  timeAnchorLocalEpoch = localTime.unixtime();
  timeAnchorUptimeMs = static_cast<uint64_t>(esp_timer_get_time()) / 1000ULL;
  timeAnchorTrusted = true;
}

bool getTrustedLogTime(DateTime& dateTime) {
  if (rtcOk && rtcTimeTrusted) {
    const unsigned long nowMs = millis();
    if (lastRtcPowerCheckMs == 0 ||
        nowMs - lastRtcPowerCheckMs >= RTC_POWER_CHECK_INTERVAL_MS) {
      lastRtcPowerCheckMs = nowMs;
      if (rtc.lostPower()) {
        rtcTimeTrusted = false;
        rtcHealth = "TIME UNVERIFIED";
        Serial.println("RTC lost power; using verified time anchor or recovery CSV.");
      }
    }
    if (rtcTimeTrusted) {
      DateTime rtcNow = rtc.now();
      if (validLoggerTime(rtcNow)) {
        dateTime = rtcNow;
        return true;
      }
      rtcTimeTrusted = false;
      rtcOk = false;
      rtcHealth = "TIME INVALID";
      Serial.println("RTC returned an invalid date; using verified time anchor or recovery CSV.");
    }
  }

  // This anchor is established only from a valid backed-up RTC, verified NTP,
  // or a deliberate manual time set. It remains usable in the same boot if the
  // RTC later disappears; the persisted fallback after a cold boot is NOT trusted.
  if (!timeAnchorTrusted) return false;
  const uint64_t uptimeMs = static_cast<uint64_t>(esp_timer_get_time()) / 1000ULL;
  const uint64_t localEpoch = static_cast<uint64_t>(timeAnchorLocalEpoch) +
      (uptimeMs - timeAnchorUptimeMs) / 1000ULL;
  if (localEpoch >= 4102444800ULL) return false;
  dateTime = DateTime(static_cast<uint32_t>(localEpoch));
  return validLoggerTime(dateTime);
}

/***************************************************************
 * Helpers
 ***************************************************************/
String valueOrDash(float value, bool valid, unsigned int decimals = 2) {
  if (!valid || !isfinite(value)) {
    return "--";
  }
  return String(value, decimals);
}

String jsonFloatOrNull(float value, bool valid, unsigned int decimals = 2) {
  if (!valid || !isfinite(value)) {
    return "null";
  }
  return String(value, decimals);
}

void sht3xPrintError(const char* prefix, int16_t error) {
  Serial.print(prefix);
  errorToString(error, sht3xErrorMsg, sizeof(sht3xErrorMsg));
  Serial.println(sht3xErrorMsg);
}

unsigned long normalizeSht3xIntervalMs(unsigned long requestedMs) {
  if (requestedMs < SHT3X_MIN_INTERVAL_MS) requestedMs = SHT3X_MIN_INTERVAL_MS;
  if (requestedMs > SHT3X_MAX_INTERVAL_MS) requestedMs = SHT3X_MAX_INTERVAL_MS;
  return requestedMs;
}

unsigned long sensorStaleLimitMs(unsigned long sampleIntervalMs) {
  // 3 expected sample periods + a small scheduling margin. Saturate safely
  // instead of overflowing unsigned long for an unusually large interval.
  const unsigned long maxBeforeMultiply =
      (0xFFFFFFFFUL - SENSOR_STALE_MARGIN_MS) / 3UL;

  unsigned long limit;
  if (sampleIntervalMs > maxBeforeMultiply) {
    limit = 0xFFFFFFFFUL;
  } else {
    limit = sampleIntervalMs * 3UL + SENSOR_STALE_MARGIN_MS;
  }

  if (limit < SENSOR_STALE_MIN_MS) limit = SENSOR_STALE_MIN_MS;
  return limit;
}

bool sps30DataUsable(unsigned long nowMs) {
  if (!sps30HasValidData) return false;
  return (nowMs - lastSps30SampleMs) <= sensorStaleLimitMs(SPS30_READ_INTERVAL);
}

bool sht3xDataUsable(unsigned long nowMs) {
  if (!sht3xHasValidData) return false;
  return (nowMs - lastSht3xSampleMs) <= sensorStaleLimitMs(SHT3X_READ_INTERVAL);
}

void formatRtcDateTime(const DateTime& now, char* dateBuffer, size_t dateLen,
                       char* timeBuffer, size_t timeLen) {
  snprintf(dateBuffer, dateLen, "%02d-%02d-%04d",
           now.day(), now.month(), now.year());
  snprintf(timeBuffer, timeLen, "%02d:%02d:%02d",
           now.hour(), now.minute(), now.second());
}

// The DS3231 stores local IST. X.509 validation uses UTC epoch time, so copy
// the RTC into the ESP32 system clock before secure PEAP/HTTPS connections.
bool syncSystemClockFromRtc() {
  if (!rtcOk) {
    Serial.println("Cannot set ESP32 system clock: RTC is not available.");
    return false;
  }

  DateTime rtcLocal = rtc.now();
  if (rtcLocal.year() < 2024 || rtcLocal.year() > 2099) {
    Serial.println("Cannot set ESP32 system clock: RTC date is invalid.");
    return false;
  }

  int64_t utcEpoch =
      (int64_t)rtcLocal.unixtime() - (int64_t)NTP_UTC_OFFSET_SECONDS;
  if (utcEpoch <= 0) return false;

  struct timeval tv;
  tv.tv_sec = (time_t)utcEpoch;
  tv.tv_usec = 0;
  if (settimeofday(&tv, nullptr) != 0) {
    Serial.println("settimeofday() failed.");
    return false;
  }
  return true;
}

bool iitdIdentityConfigured() {
  String u = IITD_EAP_USERNAME;
  return u.length() > 0 && u.indexOf("YOUR_") < 0;
}

// Secure IITD PEAP authentication using the ESP-IDF trusted-root bundle.
// Certificate validity dates remain enabled, so a valid RTC is required.
bool prepareIitdEnterpriseSecurity() {
  if (!iitdIdentityConfigured()) {
    Serial.println("IITD username is not configured in the firmware.");
    return false;
  }
  if (!syncSystemClockFromRtc()) {
    Serial.println("IITD_WIFI secure authentication requires a valid RTC time.");
    return false;
  }

  esp_eap_client_clear_ca_cert();
  esp_err_t bundleResult = esp_eap_client_use_default_cert_bundle(true);
  if (bundleResult != ESP_OK) {
    Serial.print("Could not enable EAP CA bundle: ");
    Serial.println(esp_err_to_name(bundleResult));
    return false;
  }

  // false means certificate NotBefore/NotAfter checks stay enabled.
  esp_err_t timeResult = esp_eap_client_set_disable_time_check(false);
  if (timeResult != ESP_OK) {
    Serial.print("Could not enable EAP certificate time validation: ");
    Serial.println(esp_err_to_name(timeResult));
    return false;
  }

  Serial.println("IITD EAP ready: trusted CA bundle + certificate time validation ON.");
  return true;
}

String iso8601FromRtc() {
  DateTime now;
  if (!getTrustedLogTime(now)) return "";
  char b[32];
  snprintf(b, sizeof(b), "%04d-%02d-%02dT%02d:%02d:%02d+05:30",
           now.year(), now.month(), now.day(),
           now.hour(), now.minute(), now.second());
  return String(b);
}

String jsonEscape(const String& input) {
  String out;
  out.reserve(input.length() + 8);
  for (size_t i = 0; i < input.length(); ++i) {
    char c = input.charAt(i);
    if (c == '\\' || c == '"') { out += '\\'; out += c; }
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else out += c;
  }
  return out;
}

bool cloudConfigured() {
  String base = CLOUD_FUNCTIONS_BASE;
  String secret = CLOUD_DEVICE_SECRET;
  String id = CLOUD_DEVICE_ID;
  return base.startsWith("https://") && base.indexOf("YOUR_PROJECT_REF") < 0 &&
         secret.length() > 0 && secret.indexOf("YOUR_DEVICE_SECRET") < 0 &&
         id.length() > 0;
}

String cloudUrl(const char* functionName) {
  String base = CLOUD_FUNCTIONS_BASE;
  while (base.endsWith("/")) base.remove(base.length() - 1);
  return base + "/" + functionName;
}

void addCloudHeaders(HTTPClient& http) {
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-ID", CLOUD_DEVICE_ID);
  http.addHeader("X-Device-Key", CLOUD_DEVICE_SECRET);
}

void noteCloudResult(const String& action, int httpCode) {
  LoggerStateLock guard;
  lastCloudHttpCode = httpCode;
  cloudLastAction = action;
  if (httpCode >= 200 && httpCode < 300) {
    lastCloudSuccessMs = millis();
    cloudHealth = "OK - " + action;
  } else if (httpCode > 0) {
    cloudHealth = "HTTP " + String(httpCode) + " - " + action;
  } else {
    cloudHealth = "NETWORK ERROR - " + action;
  }
}

int cloudPost(const char* functionName, const String& body, String* response = nullptr) {
  { LoggerStateLock guard; if (!connected || !cloudConfigured()) return -1; }

  NetworkClientSecure client;
  client.useBuiltinCACertBundle();
  client.setHandshakeTimeout(8);
  client.setTimeout(CLOUD_HTTP_TIMEOUT_MS);

  HTTPClient http;
  http.setConnectTimeout(CLOUD_HTTP_TIMEOUT_MS);
  http.setTimeout(CLOUD_HTTP_TIMEOUT_MS);
  if (!http.begin(client, cloudUrl(functionName))) return -1;
  addCloudHeaders(http);
  int code = http.POST(body);
  if (response && code > 0) *response = http.getString();
  http.end();
  noteCloudResult(functionName, code);
  return code;
}

int cloudGet(const char* functionName, String* response = nullptr) {
  { LoggerStateLock guard; if (!connected || !cloudConfigured()) return -1; }

  NetworkClientSecure client;
  client.useBuiltinCACertBundle();
  client.setHandshakeTimeout(8);
  client.setTimeout(CLOUD_HTTP_TIMEOUT_MS);

  HTTPClient http;
  http.setConnectTimeout(CLOUD_HTTP_TIMEOUT_MS);
  http.setTimeout(CLOUD_HTTP_TIMEOUT_MS);
  if (!http.begin(client, cloudUrl(functionName))) return -1;
  http.addHeader("X-Device-ID", CLOUD_DEVICE_ID);
  http.addHeader("X-Device-Key", CLOUD_DEVICE_SECRET);
  int code = http.GET();
  if (response && code > 0) *response = http.getString();
  http.end();
  noteCloudResult(functionName, code);
  return code;
}

String jsonStringValue(const String& json, const char* key) {
  String needle = String("\"") + key + "\"";
  int p = json.indexOf(needle);
  if (p < 0) return "";
  p = json.indexOf(':', p + needle.length());
  if (p < 0) return "";
  ++p;
  while (p < (int)json.length() && isspace((unsigned char)json.charAt(p))) ++p;
  if (p >= (int)json.length() || json.charAt(p) != '"') return "";
  ++p;
  String out;
  bool escaped = false;
  for (; p < (int)json.length(); ++p) {
    char c = json.charAt(p);
    if (escaped) {
      if (c == 'n') out += '\n';
      else if (c == 'r') out += '\r';
      else if (c == 't') out += '\t';
      else out += c;
      escaped = false;
    } else if (c == '\\') {
      escaped = true;
    } else if (c == '"') {
      break;
    } else {
      out += c;
    }
  }
  return out;
}

bool safeCsvFilename(const String& name) {
  return name.length() > 0 && name.indexOf("..") < 0 &&
         name.indexOf('/') < 0 && name.indexOf('\\') < 0 &&
         name.endsWith(".csv");
}

bool parseHttpsUrl(const String& url, String& host, uint16_t& port, String& path) {
  if (!url.startsWith("https://")) return false;
  int hostStart = 8;
  int pathStart = url.indexOf('/', hostStart);
  String hostPort = pathStart >= 0 ? url.substring(hostStart, pathStart)
                                   : url.substring(hostStart);
  path = pathStart >= 0 ? url.substring(pathStart) : "/";
  int colon = hostPort.lastIndexOf(':');
  port = 443;
  if (colon > 0) {
    port = (uint16_t)hostPort.substring(colon + 1).toInt();
    host = hostPort.substring(0, colon);
  } else {
    host = hostPort;
  }
  return host.length() > 0;
}


/***************************************************************
 * Startup OLED helpers
 ***************************************************************/
void showStartupScreen(const char* line1, const char* line2 = nullptr,
                       const char* line3 = nullptr) {
  if (!displayOk) return;
  display.clearDisplay();
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  display.setCursor(0, 0);
  display.println("LOGGER STARTUP");
  display.println("--------------");
  if (line1) display.println(line1);
  if (line2) display.println(line2);
  if (line3) display.println(line3);
  display.display();
}

/***************************************************************
 * HTML helpers
 ***************************************************************/
String getHtmlHeader(const String& title) {
  String html = F(
    "<!DOCTYPE html><html><head>"
    "<meta charset='utf-8'/>"
    "<meta name='viewport' content='width=device-width, initial-scale=1'/>"
    "<title>");
  html += title;
  html += F(
    "</title>"
    "<style>"
    "body{font-family:Arial,sans-serif;margin:20px;background:#f0f0f0;color:#333;}"
    "h1,h2,h3{color:#333;}"
    "p,a,label,input{font-size:14px;}"
    "a{text-decoration:none;}"
    ".card{background:#fff;border-radius:7px;box-shadow:0 0 10px rgba(0,0,0,.10);margin:20px 0;padding:20px;}"
    ".card h2{margin-top:0;}"
    ".btn{display:inline-block;padding:8px 16px;margin:5px 0;background:#333;color:#fff;border:0;border-radius:4px;text-decoration:none;cursor:pointer;}"
    ".btn:hover{background:#555;}"
    "table{width:100%;border-collapse:collapse;margin-top:10px;}"
    "th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;}"
    "th{background:#fafafa;}"
    ".row{margin:8px 0;}"
    ".row label{display:inline-block;min-width:105px;}"
    "input[type='number']{width:125px;padding:3px;}"
    ".ok{color:#176b2c;font-weight:bold;}"
    ".warn{color:#a04a00;font-weight:bold;}"
    ".err{color:#a00000;font-weight:bold;}"
    ".healthgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;}"
    ".healthitem{border:1px solid #ddd;border-radius:6px;padding:10px;background:#fafafa;}"
    ".bigstatus{font-size:20px;font-weight:bold;}"
    "</style></head><body><h1>");
  html += title;
  html += F("</h1>");
  return html;
}

String getHtmlFooter() {
  return F("</body></html>");
}

/***************************************************************
 * Web handlers
 ***************************************************************/
void handleRoot() {
  String html = getHtmlHeader(String(DEVICE_HOSTNAME) + " Air Quality Logger");

  html += F("<div class='card'><h2>System Health</h2>");
  html += F("<p id='overallHealth' class='bigstatus'>Checking...</p>");
  html += F("<div class='healthgrid'>");
  html += F("<div class='healthitem'><b>XIAO ESP32S3</b><br><span id='xiaoHealth' class='ok'>OK</span></div>");
  html += F("<div class='healthitem'><b>OLED</b><br><span id='oledHealth'>--</span></div>");
  html += F("<div class='healthitem'><b>RTC / DS3231</b><br><span id='rtcHealth'>--</span></div>");
  html += F("<div class='healthitem'><b>SPS30</b><br><span id='spsHealth'>--</span></div>");
  html += F("<div class='healthitem'><b>SHT3x</b><br><span id='shtHealth'>--</span></div>");
  html += F("<div class='healthitem'><b>SD / Logging</b><br><span id='sdHealth'>--</span></div>");
  html += F("<div class='healthitem'><b>Wi-Fi</b><br><span id='wifiHealth'>--</span></div>");
  html += F("<div class='healthitem'><b>Web Server</b><br><span id='webHealth'>--</span></div>");
  html += F("<div class='healthitem'><b>Remote Cloud</b><br><span id='cloudHealth'>--</span></div>");
  html += F("</div><p id='diagnosticHint'></p></div>");

  html += F("<div class='card'><h2>Live Status</h2>");
  html += F("<p>Readings update automatically every second. SD logging remains independent of the browser.</p>");
  html += F("<p id='liveStatus' class='ok'>Live updates active</p>");
  html += F("<p id='lastBrowserUpdate'>Waiting for first browser update...</p></div>");

  html += F("<div class='card'><h2>SPS30 Data</h2>");
  html += "<p id='spsStatus'>--</p>";
  html += F("<table><tr><th>Parameter</th><th>Value</th></tr>");
  html += "<tr><td>PM1.0 (ug/m3)</td><td id='pm1'>--</td></tr>";
  html += "<tr><td>PM2.5 (ug/m3)</td><td id='pm25'>--</td></tr>";
  html += "<tr><td>PM4.0 (ug/m3)</td><td id='pm4'>--</td></tr>";
  html += "<tr><td>PM10 (ug/m3)</td><td id='pm10'>--</td></tr>";
#ifndef SPS30_LIMITED_I2C_BUFFER_SIZE
  html += "<tr><td>NC0.5 (particles/cm3)</td><td id='nc05'>--</td></tr>";
  html += "<tr><td>NC1.0 (particles/cm3)</td><td id='nc1'>--</td></tr>";
  html += "<tr><td>NC2.5 (particles/cm3)</td><td id='nc25'>--</td></tr>";
  html += "<tr><td>NC4.0 (particles/cm3)</td><td id='nc4'>--</td></tr>";
  html += "<tr><td>NC10.0 (particles/cm3)</td><td id='nc10'>--</td></tr>";
#endif
  html += "<tr><td>Typical Particle Size (um)</td><td id='particleSize'>--</td></tr>";
  html += F("</table></div>");

  html += F("<div class='card'><h2>SHT3x Data</h2>");
  html += "<p id='shtStatus'>--</p>";
  html += F("<table><tr><th>Parameter</th><th>Value</th></tr>");
  html += "<tr><td>Temperature (&deg;C)</td><td id='temp'>--</td></tr>";
  html += "<tr><td>Humidity (%RH)</td><td id='rh'>--</td></tr>";
  html += F("</table></div>");

  html += F("<div class='card'><h2>Logger</h2>");
  html += "<p>Hostname: <b>" + String(NETWORK_HOSTNAME) + ".local</b></p>";
  html += F("<p>RTC Time: <span id='rtcTime'>--</span></p>");
  html += F("<p>IP Address: <span id='wifiIp'>--</span></p>");
  html += F("<p>Wi-Fi RSSI: <span id='wifiRssi'>--</span></p>");
  html += F("<p>Remote cloud: <span id='cloudSummary'>--</span></p>");
  html += "<p>Current SD file: <b>" + getLogDownloadName() + "</b></p>";
  html += F("<p>Last successful SD write: <span id='lastSdWrite'>--</span></p>");
  html += F("</div>");

  html += F("<div class='card'><h2>Controls</h2>");
  html += F("<p><a class='btn' href='/config'>Configure Intervals</a></p>");
  html += F("<p><a class='btn' href='/rtc'>Set RTC Time</a></p>");
  html += F("<p><a class='btn' href='/download'>Download Current SD Log</a></p>");
  html += F("<p><a class='btn' href='/files'>Stored Weekly Files</a></p>");
  html += F("</div>");

  html += R"rawliteral(
<script>
function putNumber(id, value, decimals) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = (value === null || value === undefined || Number.isNaN(Number(value))) ? '--' : Number(value).toFixed(decimals);
}
function setHealth(id, text, good, warning=false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className = good ? 'ok' : (warning ? 'warn' : 'err');
}
async function refreshLiveData() {
  const liveStatus = document.getElementById('liveStatus');
  try {
    const response = await fetch('/live?ts=' + Date.now(), {cache:'no-store'});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const d = await response.json();

    putNumber('pm1', d.pm1, 2); putNumber('pm25', d.pm25, 2);
    putNumber('pm4', d.pm4, 2); putNumber('pm10', d.pm10, 2);
    putNumber('nc05', d.nc05, 2); putNumber('nc1', d.nc1, 2);
    putNumber('nc25', d.nc25, 2); putNumber('nc4', d.nc4, 2);
    putNumber('nc10', d.nc10, 2); putNumber('particleSize', d.particleSize, 2);
    putNumber('temp', d.temp, 2); putNumber('rh', d.rh, 2);

    setHealth('oledHealth', d.oledHealth, d.oledOk);
    setHealth('rtcHealth', d.rtcHealth, d.rtcOk && d.timeVerified, d.timeVerified);
    setHealth('spsHealth', d.spsHealth, d.spsValid, d.spsInitialized);
    setHealth('shtHealth', d.shtHealth, d.shtValid, d.shtInitialized);
    setHealth('sdHealth', d.sdHealth, d.sdHealthy, d.sdReady);
    setHealth('wifiHealth', d.connected ? 'CONNECTED' : 'OFFLINE', d.connected, true);
    setHealth('webHealth', d.webRunning ? 'RUNNING' : 'WAITING FOR WIFI', d.webRunning, true);
    setHealth('cloudHealth', d.cloudHealth, d.cloudOk, true);

    const allRequired = d.oledOk && d.timeVerified && d.spsValid && d.shtValid && d.sdHealthy;
    const overall = document.getElementById('overallHealth');
    overall.textContent = allRequired ? 'SYSTEM HEALTHY - LOGGING' : 'ATTENTION REQUIRED';
    overall.className = 'bigstatus ' + (allRequired ? 'ok' : 'err');
    document.getElementById('diagnosticHint').textContent = d.hint;

    const spsStatus = document.getElementById('spsStatus');
    spsStatus.textContent = d.spsHealth + (d.spsAgeMs !== null ? ' | sample age ' + Math.round(d.spsAgeMs/1000) + ' s' : '');
    spsStatus.className = d.spsValid ? 'ok' : 'err';

    const shtStatus = document.getElementById('shtStatus');
    shtStatus.textContent = d.shtHealth + (d.shtAgeMs !== null ? ' | sample age ' + Math.round(d.shtAgeMs/1000) + ' s' : '');
    shtStatus.className = d.shtValid ? 'ok' : 'err';

    document.getElementById('wifiIp').textContent = d.connected ? d.ip : '--';
    document.getElementById('wifiRssi').textContent = d.connected ? (d.rssi + ' dBm') : '--';
    document.getElementById('cloudSummary').textContent = d.cloudHealth + (d.cloudLastSuccessAgeSec !== null ? (' | last success ' + d.cloudLastSuccessAgeSec + ' s ago') : '');
    document.getElementById('rtcTime').textContent = d.rtc;
    document.getElementById('lastSdWrite').textContent = d.lastSdWrite;
    liveStatus.textContent = 'Live updates active'; liveStatus.className = 'ok';
    document.getElementById('lastBrowserUpdate').textContent = 'Last browser update: ' + new Date().toLocaleTimeString();
  } catch (err) {
    liveStatus.textContent = 'Live update unavailable'; liveStatus.className = 'warn';
  }
}
refreshLiveData(); setInterval(refreshLiveData, 1000);
</script>
)rawliteral";

  html += getHtmlFooter();
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  server.send(200, "text/html", html);
}

void handleLiveData() {
  unsigned long liveMs = millis();
  bool spsLiveUsable = sps30DataUsable(liveMs);
  bool shtLiveUsable = sht3xDataUsable(liveMs);

  if (sps30Initialized && !spsLiveUsable && sps30HasValidData) sps30Health = "STALE DATA";
  if (sht3xInitialized && !shtLiveUsable && sht3xHasValidData) sht3xHealth = "STALE DATA";
  if (sps30Initialized && !sps30HasValidData && sps30Health == "OK") sps30Health = "WAITING FOR DATA";
  if (sht3xInitialized && !sht3xHasValidData && sht3xHealth == "OK") sht3xHealth = "WAITING FOR DATA";
  DateTime trustedNow;
  const bool timeVerified = getTrustedLogTime(trustedNow);
  rtcHealth = !rtcOk ? (timeVerified ? "RTC NOT FOUND - TIME VERIFIED" : "NOT FOUND")
                     : (rtcTimeTrusted ? "OK" : (timeVerified ? "TIME FROM NTP" : "TIME UNVERIFIED"));

  String rtcText = timeVerified ? trustedNow.timestamp(DateTime::TIMESTAMP_FULL)
                                : String("Unverified; writing recovery CSV");

  String lastSdWriteText = "--";
  if (lastSuccessfulSdWriteMs > 0) {
    lastSdWriteText = String((liveMs-lastSuccessfulSdWriteMs)/1000UL) + " s ago";
  }

  bool sdHealthy = sdReady && sdLastWriteOk && lastSuccessfulSdWriteMs > 0;
  String hint = "All required components are operating normally.";
  if (!displayOk) hint = "OLED not detected. Check expansion-board seating, I2C connection and power.";
  else if (!timeVerified) hint = "Clock unverified. SD logging continues in a recovery CSV until time is verified.";
  else if (!rtcOk) hint = "RTC not detected. Using verified same-boot time; check DS3231 power and I2C wiring.";
  else if (!sps30Initialized) hint = "SPS30 not detected. Check SPS30 power and I2C wiring.";
  else if (!spsLiveUsable) hint = "SPS30 is connected but data is missing/stale. Check airflow, power and I2C connection.";
  else if (!sht3xInitialized) hint = "SHT3x not detected. Check SHT3x power, SDA/SCL and address.";
  else if (!shtLiveUsable) hint = "SHT3x is connected but data is missing/stale. Check I2C connection and sensor warm-up.";
  else if (!sdReady) hint = "SD card unavailable. Check card insertion, formatting and expansion-board connection.";
  else if (!sdLastWriteOk) hint = "SD card initialized but the most recent log write failed.";

  String json = F("{");
  json += F("\"spsValid\":"); json += spsLiveUsable ? F("true") : F("false");
  json += F(",\"shtValid\":"); json += shtLiveUsable ? F("true") : F("false");
  json += F(",\"connected\":"); json += connected ? F("true") : F("false");
  json += F(",\"oledOk\":"); json += displayOk ? F("true") : F("false");
  json += F(",\"rtcOk\":"); json += rtcOk ? F("true") : F("false");
  json += F(",\"timeVerified\":"); json += timeVerified ? F("true") : F("false");
  json += F(",\"spsInitialized\":"); json += sps30Initialized ? F("true") : F("false");
  json += F(",\"shtInitialized\":"); json += sht3xInitialized ? F("true") : F("false");
  json += F(",\"sdReady\":"); json += sdReady ? F("true") : F("false");
  json += F(",\"sdHealthy\":"); json += sdHealthy ? F("true") : F("false");
  json += F(",\"webRunning\":"); json += (connected && webServerStarted) ? F("true") : F("false");

  json += F(",\"oledHealth\":\""); json += displayOk ? "OK" : "NOT FOUND"; json += F("\"");
  json += F(",\"rtcHealth\":\""); json += rtcHealth; json += F("\"");
  json += F(",\"spsHealth\":\""); json += sps30Health; json += F("\"");
  json += F(",\"shtHealth\":\""); json += sht3xHealth; json += F("\"");
  json += F(",\"sdHealth\":\""); json += sdHealth; json += F("\"");

  json += F(",\"pm1\":"); json += jsonFloatOrNull(measurement.mc_1p0, spsLiveUsable);
  json += F(",\"pm25\":"); json += jsonFloatOrNull(measurement.mc_2p5, spsLiveUsable);
  json += F(",\"pm4\":"); json += jsonFloatOrNull(measurement.mc_4p0, spsLiveUsable);
  json += F(",\"pm10\":"); json += jsonFloatOrNull(measurement.mc_10p0, spsLiveUsable);
#ifndef SPS30_LIMITED_I2C_BUFFER_SIZE
  json += F(",\"nc05\":"); json += jsonFloatOrNull(measurement.nc_0p5, spsLiveUsable);
  json += F(",\"nc1\":"); json += jsonFloatOrNull(measurement.nc_1p0, spsLiveUsable);
  json += F(",\"nc25\":"); json += jsonFloatOrNull(measurement.nc_2p5, spsLiveUsable);
  json += F(",\"nc4\":"); json += jsonFloatOrNull(measurement.nc_4p0, spsLiveUsable);
  json += F(",\"nc10\":"); json += jsonFloatOrNull(measurement.nc_10p0, spsLiveUsable);
#else
  json += F(",\"nc05\":null,\"nc1\":null,\"nc25\":null,\"nc4\":null,\"nc10\":null");
#endif
  json += F(",\"particleSize\":"); json += jsonFloatOrNull(measurement.typical_particle_size, spsLiveUsable);
  json += F(",\"temp\":"); json += jsonFloatOrNull(temperature, shtLiveUsable);
  json += F(",\"rh\":"); json += jsonFloatOrNull(humidity, shtLiveUsable);
  json += F(",\"spsAgeMs\":"); json += sps30HasValidData ? String(liveMs-lastSps30SampleMs) : String("null");
  json += F(",\"shtAgeMs\":"); json += sht3xHasValidData ? String(liveMs-lastSht3xSampleMs) : String("null");
  json += F(",\"ip\":\""); json += connected ? WiFi.localIP().toString() : String("--");
  json += F("\",\"rssi\":"); json += connected ? String(WiFi.RSSI()) : String("null");
  bool cloudOkNow = cloudConfigured() && lastCloudSuccessMs > 0 &&
                    (liveMs - lastCloudSuccessMs) <= 180000UL;
  String cloudDisplay = cloudHealth;
  if (!cloudConfigured()) cloudDisplay = "NOT CONFIGURED";
  else if (!connected) cloudDisplay = "WAITING FOR WIFI";
  else if (remoteUploadState != REMOTE_UPLOAD_IDLE) cloudDisplay = "CSV UPLOAD ACTIVE";
  json += F(",\"cloudOk\":"); json += cloudOkNow ? F("true") : F("false");
  json += F(",\"cloudHealth\":\""); json += jsonEscape(cloudDisplay); json += F("\"");
  json += F(",\"cloudLastSuccessAgeSec\":");
  json += lastCloudSuccessMs > 0 ? String((liveMs - lastCloudSuccessMs) / 1000UL) : String("null");
  json += F(",\"rtc\":\""); json += rtcText;
  json += F("\",\"lastSdWrite\":\""); json += lastSdWriteText;
  json += F("\",\"hint\":\""); json += hint;
  json += F("\"}");

  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  server.send(200, "application/json", json);
}

void handleNotFound() {
  server.send(404, "text/plain", "404: Not found");
}

void handleRTC() {
  if (server.hasArg("year") && server.hasArg("month") && server.hasArg("day") &&
      server.hasArg("hour") && server.hasArg("minute") && server.hasArg("second")) {

    int year   = server.arg("year").toInt();
    int month  = server.arg("month").toInt();
    int day    = server.arg("day").toInt();
    int hour   = server.arg("hour").toInt();
    int minute = server.arg("minute").toInt();
    int second = server.arg("second").toInt();

    bool basicValid = (year >= 2024 && year <= 2099 &&
                       month >= 1 && month <= 12 &&
                       day >= 1 && day <= 31 &&
                       hour >= 0 && hour <= 23 &&
                       minute >= 0 && minute <= 59 &&
                       second >= 0 && second <= 59);
    if (basicValid) {
      basicValid = DateTime(year, month, day, hour, minute, second).isValid();
    }

    String html;
    if (!basicValid) {
      html = getHtmlHeader("RTC Input Error");
      html += F("<div class='card'><p class='err'>Invalid date/time values.</p>");
      html += F("<p><a class='btn' href='/rtc'>Try Again</a></p></div>");
    } else {
      DateTime dt(year, month, day, hour, minute, second);
      setTrustedTimeAnchor(dt);
      if (rtcOk) {
        rtc.adjust(dt);
        DateTime readBack = rtc.now();
        rtcTimeTrusted = validLoggerTime(readBack) &&
            llabs(static_cast<int64_t>(readBack.unixtime()) - dt.unixtime()) <= 2;
        rtcHealth = rtcTimeTrusted ? "OK" : "RTC WRITE FAILED";
        if (!rtcTimeTrusted) rtcOk = false;
      }
      struct timeval tv;
      tv.tv_sec = static_cast<time_t>(dt.unixtime() - NTP_UTC_OFFSET_SECONDS);
      tv.tv_usec = 0;
      settimeofday(&tv, nullptr);
      rtcPreferences.putULong("lastTime", dt.unixtime());
      lastRtcCheckpointMs = millis();

      html = getHtmlHeader("RTC Updated");
      html += F("<div class='card'><h2>RTC Updated</h2><p>");
      html += String(year) + "-" + String(month) + "-" + String(day) + " " +
              String(hour) + ":" + String(minute) + ":" + String(second);
      html += F("</p><p><a class='btn' href='/'>Back to Main</a></p></div>");
    }
    html += getHtmlFooter();
    server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    server.send(200, "text/html", html);
    return;
  }

  DateTime now;
  if (!getTrustedLogTime(now)) now = DateTime(F(__DATE__), F(__TIME__));
  String html = getHtmlHeader("Set RTC Time");

  html += F("<div class='card'><h2>Quick RTC Sync</h2>");
  html += F("<p>This button captures the current date and time from the phone/computer at the exact moment you click it, then immediately sends it to the XIAO.</p>");
  html += F("<button class='btn' type='button' onclick='setRtcFromDeviceNow()'>Set RTC to Current Device Time</button>");
  html += F("<p id='deviceTimePreview'></p>");
  html += F("</div>");

  html += F("<div class='card'><h2>Manual RTC Time</h2>");
  html += F("<p>Use these fields only if you want to enter a specific time manually. When Wi-Fi has internet access, NTP can also correct the RTC automatically.</p>");
  html += F("<form id='rtcForm' action='/rtc' method='get'>");

  html += "<div class='row'><label>Year:</label><input id='year' type='number' name='year' min='2024' max='2099' value='" + String(now.year()) + "' required></div>";
  html += "<div class='row'><label>Month:</label><input id='month' type='number' name='month' min='1' max='12' value='" + String(now.month()) + "' required></div>";
  html += "<div class='row'><label>Day:</label><input id='day' type='number' name='day' min='1' max='31' value='" + String(now.day()) + "' required></div>";
  html += "<div class='row'><label>Hour:</label><input id='hour' type='number' name='hour' min='0' max='23' value='" + String(now.hour()) + "' required></div>";
  html += "<div class='row'><label>Minute:</label><input id='minute' type='number' name='minute' min='0' max='59' value='" + String(now.minute()) + "' required></div>";
  html += "<div class='row'><label>Second:</label><input id='second' type='number' name='second' min='0' max='59' value='" + String(now.second()) + "' required></div>";

  html += F("<input class='btn' type='submit' value='Update RTC From Fields'></form></div>");
  html += F("<p><a class='btn' href='/'>Back to Main</a></p>");

  html += R"rawliteral(
<script>
function updateDevicePreview() {
  const now = new Date();
  const p = document.getElementById('deviceTimePreview');
  if (p) p.textContent = 'Current device time: ' + now.toLocaleString();
}

function setRtcFromDeviceNow() {
  // Capture the browser's local clock immediately before submitting.
  const now = new Date();
  document.getElementById('year').value = now.getFullYear();
  document.getElementById('month').value = now.getMonth() + 1;
  document.getElementById('day').value = now.getDate();
  document.getElementById('hour').value = now.getHours();
  document.getElementById('minute').value = now.getMinutes();
  document.getElementById('second').value = now.getSeconds();
  document.getElementById('rtcForm').submit();
}

updateDevicePreview();
setInterval(updateDevicePreview, 1000);
</script>
)rawliteral";

  html += getHtmlFooter();
  server.sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  server.send(200, "text/html", html);
}


void handleFileList() {
  String html = getHtmlHeader(String(DEVICE_HOSTNAME) + " Stored Files");
  html += "<div class='card'><h2>Stored CSV Files</h2>";
  html += "<p>Weekly files and time-recovery files are preserved on the SD card.</p>";
  html += "<p>Current file: <b>" + getLogDownloadName() + "</b></p>";
  html += "<table><tr><th>File</th><th>Size</th><th>Action</th></tr>";

  File root = SD.open("/");
  if (root && root.isDirectory()) {
    File entry = root.openNextFile();

    while (entry) {
      String name = entry.name();

      if (!entry.isDirectory() && name.endsWith(".csv")) {
        if (name.startsWith("/")) name.remove(0, 1);

        html += "<tr><td>" + name + "</td><td>" +
                String((uint32_t)entry.size()) +
                " bytes</td><td><a class='btn' href='/downloadfile?name=" +
                name + "'>Download</a></td></tr>";
      }

      entry.close();
      entry = root.openNextFile();
    }

    root.close();
  }

  html += "</table>";
  html += "<p><a class='btn' href='/'>Back</a></p>";
  html += "</div></body></html>";

  server.send(200, "text/html", html);
}

void handleDownloadFile() {
  if (!server.hasArg("name")) {
    server.send(400, "text/plain", "Missing file name");
    return;
  }

  String name = server.arg("name");

  // Only allow root-level CSV files.
  if (name.indexOf("..") >= 0 ||
      name.indexOf('/') >= 0 ||
      name.indexOf('\\') >= 0 ||
      !name.endsWith(".csv")) {
    server.send(400, "text/plain", "Invalid file name");
    return;
  }

  String path = "/" + name;
  File file = SD.open(path.c_str(), FILE_READ);

  if (!file) {
    server.send(404, "text/plain", "File not found");
    return;
  }

  server.sendHeader("Content-Disposition",
                    "attachment; filename=" + name);
  server.sendHeader("Cache-Control", "no-store");
  server.streamFile(file, "text/csv");
  file.close();
}

void handleDownload() {
  File file = SD.open(getLogFilePath().c_str(), FILE_READ);
  if (!file) {
    server.send(404, "text/plain", "File not found");
    return;
  }

  server.sendHeader("Content-Disposition", "attachment; filename=" + getLogDownloadName());
  server.sendHeader("Cache-Control", "no-store");
  server.streamFile(file, "text/csv");
  file.close();
}

/***************************************************************
 * Interval preferences + web configuration
 ***************************************************************/
void loadIntervalsFromPrefs() {
  intervalPrefs.begin(INTERVAL_PREF_NAMESPACE, true);
  PM_PAGE_INTERVAL    = intervalPrefs.getULong("pmPage", 3000UL);
  NC_PAGE_INTERVAL    = intervalPrefs.getULong("ncPage", 3000UL);
  SHT3X_PAGE_INTERVAL = intervalPrefs.getULong("shtPage", 6000UL);
  IP_PAGE_INTERVAL    = intervalPrefs.getULong("ipPage", 3000UL);
  SPS30_READ_INTERVAL = intervalPrefs.getULong("spsRead", 2000UL);
  SHT3X_READ_INTERVAL = intervalPrefs.getULong("shtRead", 2000UL);
  LOG_INTERVAL        = intervalPrefs.getULong("log", 2000UL);
  intervalPrefs.end();

  PM_PAGE_INTERVAL = max(PM_PAGE_INTERVAL, DISPLAY_MIN_INTERVAL_MS);
  NC_PAGE_INTERVAL = max(NC_PAGE_INTERVAL, DISPLAY_MIN_INTERVAL_MS);
  SHT3X_PAGE_INTERVAL = max(SHT3X_PAGE_INTERVAL, DISPLAY_MIN_INTERVAL_MS);
  IP_PAGE_INTERVAL = max(IP_PAGE_INTERVAL, DISPLAY_MIN_INTERVAL_MS);
  SPS30_READ_INTERVAL = max(SPS30_READ_INTERVAL, SPS30_MIN_INTERVAL_MS);
  SHT3X_READ_INTERVAL = normalizeSht3xIntervalMs(SHT3X_READ_INTERVAL);
  LOG_INTERVAL = max(LOG_INTERVAL, LOG_MIN_INTERVAL_MS);
}

void saveIntervalsToPrefs() {
  intervalPrefs.begin(INTERVAL_PREF_NAMESPACE, false);
  intervalPrefs.putULong("pmPage", PM_PAGE_INTERVAL);
  intervalPrefs.putULong("ncPage", NC_PAGE_INTERVAL);
  intervalPrefs.putULong("shtPage", SHT3X_PAGE_INTERVAL);
  intervalPrefs.putULong("ipPage", IP_PAGE_INTERVAL);
  intervalPrefs.putULong("spsRead", SPS30_READ_INTERVAL);
  intervalPrefs.putULong("shtRead", SHT3X_READ_INTERVAL);
  intervalPrefs.putULong("log", LOG_INTERVAL);
  intervalPrefs.end();
}

unsigned long webArgULong(const char* name, unsigned long fallback) {
  if (!server.hasArg(name)) return fallback;
  String s = server.arg(name);
  if (s.length() == 0) return fallback;
  unsigned long value = strtoul(s.c_str(), nullptr, 10);
  return value;
}

void handleConfig() {
  String statusMessage = "";

  if (server.hasArg("pmPage")) {
    unsigned long newPmPage  = max(webArgULong("pmPage", PM_PAGE_INTERVAL), DISPLAY_MIN_INTERVAL_MS);
    unsigned long newNcPage  = max(webArgULong("ncPage", NC_PAGE_INTERVAL), DISPLAY_MIN_INTERVAL_MS);
    unsigned long newShtPage = max(webArgULong("shtPage", SHT3X_PAGE_INTERVAL), DISPLAY_MIN_INTERVAL_MS);
    unsigned long newIpPage  = max(webArgULong("ipPage", IP_PAGE_INTERVAL), DISPLAY_MIN_INTERVAL_MS);
    unsigned long newSpsRead = max(webArgULong("spsRead", SPS30_READ_INTERVAL), SPS30_MIN_INTERVAL_MS);
    unsigned long newShtRead = normalizeSht3xIntervalMs(webArgULong("shtRead", SHT3X_READ_INTERVAL));
    unsigned long newLog     = max(webArgULong("log", LOG_INTERVAL), LOG_MIN_INTERVAL_MS);

    PM_PAGE_INTERVAL = newPmPage;
    NC_PAGE_INTERVAL = newNcPage;
    SHT3X_PAGE_INTERVAL = newShtPage;
    IP_PAGE_INTERVAL = newIpPage;
    SPS30_READ_INTERVAL = newSpsRead;
    SHT3X_READ_INTERVAL = newShtRead;
    LOG_INTERVAL = newLog;

    lastSps30PollMs = 0;
    lastSht3xPollMs = 0;
    lastLogMs = millis();
    lastPageToggleMs = millis();
    displayNeedsRefresh = true;

    saveIntervalsToPrefs();
    statusMessage = "<p class='ok'>Settings updated and saved.</p>";
  }

  String html = getHtmlHeader("Configure Intervals");

  if (statusMessage.length() > 0) {
    html += "<div class='card'>" + statusMessage + "</div>";
  }

  html += F("<form method='get' action='/config'>");

  html += F("<div class='card'><h2>OLED Page Durations (ms)</h2>");
  html += "<div class='row'><label>PM</label><input name='pmPage' type='number' min='500' step='100' value='" + String(PM_PAGE_INTERVAL) + "' required></div>";
  html += "<div class='row'><label>NC</label><input name='ncPage' type='number' min='500' step='100' value='" + String(NC_PAGE_INTERVAL) + "' required></div>";
  html += "<div class='row'><label>SHT3x Page</label><input name='shtPage' type='number' min='500' step='100' value='" + String(SHT3X_PAGE_INTERVAL) + "' required></div>";
  html += "<div class='row'><label>IP Page</label><input name='ipPage' type='number' min='500' step='100' value='" + String(IP_PAGE_INTERVAL) + "' required></div>";
  html += F("</div>");

  html += F("<div class='card'><h2>Sensor & Log Intervals (ms)</h2>");
  html += "<div class='row'><label>SPS30 Read</label><input name='spsRead' type='number' min='1000' step='1000' value='" + String(SPS30_READ_INTERVAL) + "' required></div>";
  html += "<div class='row'><label>SHT3x Read</label><input name='shtRead' type='number' min='1000' max='3600000' step='100' value='" + String(SHT3X_READ_INTERVAL) + "' required></div>";
  html += "<div class='row'><label>SD Log</label><input name='log' type='number' min='1000' step='1000' value='" + String(LOG_INTERVAL) + "' required></div>";
  html += F("<p>SHT3x is sampled in single-shot mode. Recommended interval: 1000 ms or slower.</p>");
  html += F("</div>");

  html += F("<input class='btn' type='submit' value='Update & Save'></form>");
  html += F("<p><a class='btn' href='/'>Back to Main</a></p>");
  html += getHtmlFooter();
  server.send(200, "text/html", html);
}

void registerWebRoutes() {
  server.on("/", handleRoot);
  server.on("/live", handleLiveData);
  server.on("/rtc", handleRTC);
  server.on("/download", handleDownload);
  server.on("/files", handleFileList);
  server.on("/downloadfile", handleDownloadFile);
  server.on("/config", handleConfig);
  server.onNotFound(handleNotFound);
}

/***************************************************************
 * NTP service
 ***************************************************************/
void onNtpTimeSync(struct timeval* networkTime) {
  if (networkTime == nullptr) return;
  const int64_t utcSeconds = static_cast<int64_t>(networkTime->tv_sec);
  // Reject implausible server replies before they can alter the DS3231.
  if (utcSeconds < 1704067200LL || utcSeconds >= 4102444800LL) return;

  ntpEventVersion.fetch_add(1, std::memory_order_acq_rel); // writing: odd
  ntpEventUtcSeconds.store(static_cast<uint32_t>(utcSeconds), std::memory_order_relaxed);
  ntpEventMillis.store(millis(), std::memory_order_relaxed);
  ntpEventVersion.fetch_add(1, std::memory_order_release); // ready: even
}

void startNtpSync() {
  esp_sntp_set_time_sync_notification_cb(onNtpTimeSync);
  esp_sntp_set_sync_interval(NTP_SYNC_INTERVAL_MS);
  configTime(NTP_UTC_OFFSET_SECONDS,
             NTP_DST_OFFSET_SECONDS,
             NTP_SERVER_1,
             NTP_SERVER_2);
  ntpSyncPending = true;
  ntpSyncStartMs = millis();
  lastNtpAttemptMs = ntpSyncStartMs;
  ntpSyncedSinceWifiConnect = false;
  Serial.println("NTP sync started...");
}

void serviceNtpSync() {
  if (!connected) return;

  unsigned long ms = millis();
  uint32_t version = ntpEventVersion.load(std::memory_order_acquire);
  if (version != lastHandledNtpEventVersion && (version & 1U) == 0) {
    const uint32_t utcSeconds = ntpEventUtcSeconds.load(std::memory_order_relaxed);
    const uint32_t eventMs = ntpEventMillis.load(std::memory_order_relaxed);
    if (version == ntpEventVersion.load(std::memory_order_acquire)) {
      lastHandledNtpEventVersion = version;
      if (ms - eventMs > NTP_EVENT_MAX_AGE_MS) {
        Serial.println("Old NTP event ignored; requesting a fresh response.");
        startNtpSync();
        return;
      }
      // The callback provides actual SNTP time, not the RTC-seeded system clock.
      // Account for the short delay before the logger loop services the event.
      const uint64_t localEpoch = static_cast<uint64_t>(utcSeconds) +
          static_cast<uint32_t>(NTP_UTC_OFFSET_SECONDS) +
          (ms - eventMs) / 1000UL;
      if (localEpoch < 4102444800ULL) {
        DateTime ntpTime(static_cast<uint32_t>(localEpoch));
        setTrustedTimeAnchor(ntpTime);
        if (rtcOk) {
          rtc.adjust(ntpTime);
          DateTime readBack = rtc.now();
          rtcTimeTrusted = validLoggerTime(readBack) &&
              llabs(static_cast<int64_t>(readBack.unixtime()) - ntpTime.unixtime()) <= 2;
          rtcHealth = rtcTimeTrusted ? "OK" : "RTC WRITE FAILED";
          if (!rtcTimeTrusted) rtcOk = false;
        }
        rtcPreferences.putULong("lastTime", ntpTime.unixtime());
        lastRtcCheckpointMs = ms;
        ntpSyncPending = false;
        ntpSyncedSinceWifiConnect = true;
        lastSuccessfulNtpMs = ms;
        // SNTP already corrected the ESP32 clock; do not overwrite it from RTC.
        Serial.print("RTC synchronized from verified NTP response: ");
        Serial.print(ntpTime.timestamp(DateTime::TIMESTAMP_DATE));
        Serial.print(" ");
        Serial.println(ntpTime.timestamp(DateTime::TIMESTAMP_TIME));
        return;
      }
      Serial.println("NTP time is outside the DS3231 date range; RTC unchanged.");
    }
  }

  if (ntpSyncPending && ms - ntpSyncStartMs >= NTP_SYNC_TIMEOUT_MS) {
    ntpSyncPending = false;
    Serial.println("No verified NTP response yet; keeping RTC time. Will retry.");
  }

  // SNTP refreshes itself every six hours. If it cannot get a reply, restart
  // the client at most every ten minutes; never block sensor or SD logging.
  const bool needsSync = !ntpSyncedSinceWifiConnect ||
      ms - lastSuccessfulNtpMs >= NTP_SYNC_INTERVAL_MS + NTP_RETRY_INTERVAL_MS;
  if (needsSync && !ntpSyncPending &&
      ms - lastNtpAttemptMs >= NTP_RETRY_INTERVAL_MS) {
    startNtpSync();
  }
}

/***************************************************************
 * Wi-Fi service (non-blocking selection/password/connection)
 ***************************************************************/
uint64_t wifiUptimeMs() {
  return static_cast<uint64_t>(esp_timer_get_time()) / 1000ULL;
}

uint64_t wifiRetryOffsetMs(uint32_t cycleNumber) {
  if (cycleNumber <= 12) return cycleNumber * WIFI_FAST_RETRY_MS;
  return 12 * WIFI_FAST_RETRY_MS +
         static_cast<uint64_t>(cycleNumber - 12) * WIFI_SLOW_RETRY_MS;
}

void beginWifiOutage() {
  if (wifiOutageActive) return;
  wifiOutageActive = true;
  wifiOutageStartMs = wifiUptimeMs();
  wifiRetryCycleNumber = 0;
  wifiNextRetryDueMs = wifiOutageStartMs;
  wifiRetryCycleActive = false;
  nextKnownWifiOffset = 0;
}

void loadSavedWifiNetworks() {
  uint8_t storedCount = wifiPrefs.getUChar("count", 0);
  if (storedCount > MAX_SAVED_WIFI_NETWORKS) storedCount = MAX_SAVED_WIFI_NETWORKS;
  for (int i = 0; i < storedCount; ++i) {
    char ssidKey[12], passKey[12];
    snprintf(ssidKey, sizeof(ssidKey), "ssid%d", i);
    snprintf(passKey, sizeof(passKey), "pass%d", i);
    String ssid = wifiPrefs.getString(ssidKey, "");
    if (ssid.isEmpty()) continue;
    savedWifiSSIDs[savedWifiCount] = ssid;
    savedWifiPasswords[savedWifiCount] = wifiPrefs.getString(passKey, "");
    ++savedWifiCount;
  }

  // Import the single-network credentials saved by older firmware once.
  if (savedWifiCount == 0) {
    String legacySSID = wifiPrefs.getString("ssid", "");
    if (!legacySSID.isEmpty()) {
      String legacyPassword = wifiPrefs.getString("password", "");
      savedWifiSSIDs[0] = legacySSID;
      savedWifiPasswords[0] = legacyPassword;
      savedWifiCount = 1;
      preferredWifiIndex = 0;
      if (wifiPrefs.putString("ssid0", legacySSID) > 0 &&
          wifiPrefs.putString("pass0", legacyPassword) > 0 &&
          wifiPrefs.putUChar("count", 1) > 0) {
        wifiPrefs.remove("ssid");
        wifiPrefs.remove("password");
        Serial.println("Existing Wi-Fi credentials migrated to saved networks.");
      } else {
        Serial.println("Wi-Fi migration not saved; old credentials remain available.");
      }
    }
  } else {
    uint8_t storedPreferred = wifiPrefs.getUChar("preferred", 0);
    preferredWifiIndex = storedPreferred < savedWifiCount ? storedPreferred : 0;
  }
  Serial.printf("Loaded %d saved Wi-Fi network(s).\n", savedWifiCount);
}

void rememberWifiNetwork(const String& ssid, const String& password) {
  int index = -1;
  for (int i = 0; i < savedWifiCount; ++i) {
    if (savedWifiSSIDs[i] == ssid) { index = i; break; }
  }
  if (index < 0) {
    if (savedWifiCount < MAX_SAVED_WIFI_NETWORKS) {
      index = savedWifiCount;
    } else {
      index = preferredWifiIndex == MAX_SAVED_WIFI_NETWORKS - 1 ? 0 : MAX_SAVED_WIFI_NETWORKS - 1;
      Serial.println("Saved Wi-Fi list full; replacing one older network.");
    }
  }

  char ssidKey[12], passKey[12];
  snprintf(ssidKey, sizeof(ssidKey), "ssid%d", index);
  snprintf(passKey, sizeof(passKey), "pass%d", index);
  if (wifiPrefs.putString(ssidKey, ssid) == 0 ||
      wifiPrefs.putString(passKey, password) == 0 ||
      wifiPrefs.putUChar("count", max(savedWifiCount, index + 1)) == 0 ||
      wifiPrefs.putUChar("preferred", index) == 0) {
    Serial.println("Could not persist Wi-Fi credentials; check flash storage.");
  } else {
    Serial.println("Wi-Fi credentials stored.");
  }
  savedWifiSSIDs[index] = ssid;
  savedWifiPasswords[index] = password;
  if (index >= savedWifiCount) savedWifiCount = index + 1;
  preferredWifiIndex = index;
}

bool startWifiConnection(const String& ssid, const String& password,
                         bool saveOnSuccess) {
  pendingSSID = ssid;
  pendingPassword = password;
  savePendingCredentials = saveOnSuccess;

  Serial.print("Connecting to ");
  Serial.print(pendingSSID);
  Serial.println(" ...");

  WiFi.mode(WIFI_STA);

  // Keep DHCP for the numeric address; assign a permanent hostname.
  WiFi.setHostname(NETWORK_HOSTNAME);

  if (pendingSSID == IITD_WIFI_SSID) {
    Serial.println("Using IITD WPA2-Enterprise: PEAP/MSCHAPv2.");
    if (!prepareIitdEnterpriseSecurity()) {
      Serial.println("IITD_WIFI connection not started because secure EAP setup failed.");
      wifiState = WIFI_IDLE;
      savePendingCredentials = false;
      pendingPassword = "";
      return false;
    }

    WiFi.begin(
      pendingSSID.c_str(),
      WPA2_AUTH_PEAP,
      IITD_EAP_IDENTITY,
      IITD_EAP_USERNAME,
      pendingPassword.c_str());
  } else {
    // Arduino's personal-network begin() does not undo a previous IITD EAP
    // enable. Disable it explicitly before switching to WPA2/WPA3-Personal.
    esp_err_t eapResult = esp_wifi_sta_enterprise_disable();
    if (eapResult != ESP_OK && eapResult != ESP_ERR_INVALID_STATE) {
      Serial.print("Could not disable enterprise Wi-Fi authentication: ");
      Serial.println(esp_err_to_name(eapResult));
    }
    WiFi.begin(pendingSSID.c_str(), pendingPassword.c_str());
  }

  wifiConnectStartMs = millis();
  wifiState = WIFI_CONNECTING;
  return true;
}

void startWifiScan() {
  if (wifiState != WIFI_IDLE || connected) return;

  Serial.println("\nScanning for Wi-Fi networks...");
  wifiRetryCycleActive = false;
  manualWifiProvisioning = true;
  manualWifiStartMs = millis();
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  WiFi.scanDelete();

  int16_t result = WiFi.scanNetworks(true);  // asynchronous scan
  if (result == WIFI_SCAN_FAILED) {
    Serial.println("Could not start Wi-Fi scan; will retry later.");
    manualWifiProvisioning = false;
    if (savedWifiCount > 0) wifiNextRetryDueMs = wifiUptimeMs();
    lastWifiScanAttemptMs = millis();
    return;
  }

  wifiState = WIFI_SCANNING;
  lastWifiScanAttemptMs = millis();
}

void finishWifiScanIfReady() {
  if (wifiState != WIFI_SCANNING) return;

  int16_t found = WiFi.scanComplete();
  if (found == WIFI_SCAN_RUNNING) return;

  if (found < 0) {
    Serial.println("Wi-Fi scan failed; will retry later.");
    WiFi.scanDelete();
    wifiState = WIFI_IDLE;
    manualWifiProvisioning = false;
    if (savedWifiCount > 0) wifiNextRetryDueMs = wifiUptimeMs();
    lastWifiScanAttemptMs = millis();
    return;
  }

  if (found == 0) {
    Serial.println("No networks found. Logger continues; scan will retry later.");
    WiFi.scanDelete();
    wifiState = WIFI_IDLE;
    manualWifiProvisioning = false;
    if (savedWifiCount > 0) wifiNextRetryDueMs = wifiUptimeMs();
    lastWifiScanAttemptMs = millis();
    return;
  }

  numNetworks = (found > MAX_NETWORKS) ? MAX_NETWORKS : found;

  Serial.print(found);
  Serial.println(" networks found.");
  if (found > MAX_NETWORKS) {
    Serial.print("Showing first ");
    Serial.print(MAX_NETWORKS);
    Serial.println(" networks only.");
  }

  Serial.println(" Nr | SSID                             | RSSI | CH | Encryption");
  for (int i = 0; i < numNetworks; i++) {
    ssidList[i] = WiFi.SSID(i);

    Serial.printf("%2d", i + 1);
    Serial.print(" | ");
    Serial.printf("%-32.32s", WiFi.SSID(i).c_str());
    Serial.print(" | ");
    Serial.printf("%4d", WiFi.RSSI(i));
    Serial.print(" | ");
    Serial.printf("%2d", WiFi.channel(i));
    Serial.print(" | ");

    switch (WiFi.encryptionType(i)) {
      case WIFI_AUTH_OPEN:            Serial.print("open");      break;
      case WIFI_AUTH_WEP:             Serial.print("WEP");       break;
      case WIFI_AUTH_WPA_PSK:         Serial.print("WPA");       break;
      case WIFI_AUTH_WPA2_PSK:        Serial.print("WPA2");      break;
      case WIFI_AUTH_WPA_WPA2_PSK:    Serial.print("WPA+WPA2");  break;
      case WIFI_AUTH_WPA2_ENTERPRISE: Serial.print("WPA2-EAP");  break;
      case WIFI_AUTH_WPA3_PSK:        Serial.print("WPA3");      break;
      case WIFI_AUTH_WPA2_WPA3_PSK:   Serial.print("WPA2+WPA3"); break;
      case WIFI_AUTH_WAPI_PSK:        Serial.print("WAPI");      break;
      default:                        Serial.print("unknown");   break;
    }
    Serial.println();
  }

  WiFi.scanDelete();
  Serial.println();
  Serial.println("Enter the network number in Serial Monitor (or 'wifi scan' to rescan):");
  manualWifiStartMs = millis();
  wifiState = WIFI_WAIT_SELECTION;
}

void noteWifiLost() {
  if (!connected) return;
  connected = false;
  ntpSyncPending = false;
  if (mdnsStarted) {
    MDNS.end();
    mdnsStarted = false;
  }
  Serial.println("Wi-Fi connection lost. Local sensor logging continues.");
  displayNeedsRefresh = true;
  wifiState = WIFI_IDLE;
  beginWifiOutage();
}

void serviceSerialWifiInput() {
  if (!Serial.available()) return;

  String input = Serial.readStringUntil('\n');
  input.trim();

  if (input.equalsIgnoreCase("wifi scan")) {
    wifiScanRequested = true;
    if (wifiState == WIFI_SCANNING) WiFi.scanDelete();
    if (connected || wifiState == WIFI_CONNECTING) WiFi.disconnect();
    wifiState = WIFI_IDLE;
    manualWifiProvisioning = false;
    savePendingCredentials = false;
    pendingPassword = "";
    pendingSSID = "";
    currentKnownWifiIndex = -1;
    return;
  }

  if (wifiState == WIFI_WAIT_SELECTION) {
    int choice = input.toInt();
    if (choice < 1 || choice > numNetworks) {
      Serial.println("Invalid network number. Enter a listed number:");
      return;
    }

    pendingSSID = ssidList[choice - 1];
    Serial.print("Selected: ");
    Serial.println(pendingSSID);
    if (pendingSSID == IITD_WIFI_SSID) {
      Serial.print("Enter IITD Kerberos password for user ");
      Serial.print(IITD_EAP_USERNAME);
      Serial.println(" (logger continues while waiting):");
    } else {
      Serial.print("Enter password for ");
      Serial.print(pendingSSID);
      Serial.println(" (logger continues while waiting):");
    }
    manualWifiStartMs = millis();
    wifiState = WIFI_WAIT_PASSWORD;
    return;
  }

  if (wifiState == WIFI_WAIT_PASSWORD) {
    if (input.length() == 0) {
      Serial.println("Password empty. Returning to automatic Wi-Fi recovery.");
      wifiState = WIFI_IDLE;
      manualWifiProvisioning = false;
      wifiNextRetryDueMs = wifiUptimeMs();
      lastWifiScanAttemptMs = millis();
      return;
    }

    currentKnownWifiIndex = -1;
    if (!startWifiConnection(pendingSSID, input, true)) {
      manualWifiProvisioning = false;
      wifiNextRetryDueMs = wifiUptimeMs();
    }
  }
}

void serviceWifi() {
  finishWifiScanIfReady();
  serviceSerialWifiInput();

  wl_status_t status = WiFi.status();

  if (status == WL_CONNECTED) {
    if (!connected) {
      connected = true;
      wifiState = WIFI_IDLE;
      wifiOutageActive = false;
      wifiRetryCycleActive = false;
      manualWifiProvisioning = false;

      Serial.println("Wi-Fi connected!");
      Serial.print("IP Address: "); Serial.println(WiFi.localIP());
      Serial.print("Subnet Mask: "); Serial.println(WiFi.subnetMask());
      Serial.print("Gateway: "); Serial.println(WiFi.gatewayIP());
      Serial.print("DNS: "); Serial.println(WiFi.dnsIP());
      Serial.print("BSSID: "); Serial.println(WiFi.BSSIDstr());
      Serial.print("RSSI: "); Serial.print(WiFi.RSSI()); Serial.println(" dBm");

      if (savePendingCredentials && pendingSSID.length() > 0) {
        rememberWifiNetwork(pendingSSID, pendingPassword);
      } else if (currentKnownWifiIndex >= 0 &&
                 currentKnownWifiIndex != preferredWifiIndex) {
        preferredWifiIndex = currentKnownWifiIndex;
        wifiPrefs.putUChar("preferred", preferredWifiIndex);
      }
      savePendingCredentials = false;
      pendingPassword = "";
      pendingSSID = "";
      currentKnownWifiIndex = -1;

      // Re-create mDNS whenever this logger joins a network.
      // The numeric DHCP IP may change, but the friendly name remains fixed.
      if (mdnsStarted) {
        MDNS.end();
        mdnsStarted = false;
      }

      if (MDNS.begin(NETWORK_HOSTNAME)) {
        mdnsStarted = true;
        MDNS.addService("http", "tcp", 80);
        Serial.print("mDNS dashboard: http://");
        Serial.print(NETWORK_HOSTNAME);
        Serial.println(".local");
      } else {
        Serial.println("mDNS start failed; use the numeric IP shown on OLED.");
      }

      if (!webServerStarted) {
        server.begin();
        webServerStarted = true;
        Serial.println("Web server started on port 80.");
      }

      startNtpSync();
      displayNeedsRefresh = true;
    }

    server.handleClient();
    return;
  }

  noteWifiLost();

  if (wifiScanRequested) {
    wifiScanRequested = false;
    startWifiScan();
    return;
  }

  if (wifiState == WIFI_CONNECTING) {
    if (millis() - wifiConnectStartMs >= WIFI_CONNECT_TIMEOUT_MS) {
      Serial.println("Wi-Fi connection timed out. Local logging continues.");
      WiFi.disconnect();
      wifiState = WIFI_IDLE;
      savePendingCredentials = false;
      pendingPassword = "";
      pendingSSID = "";
      currentKnownWifiIndex = -1;
      if (manualWifiProvisioning) {
        manualWifiProvisioning = false;
        wifiNextRetryDueMs = wifiUptimeMs();
      }
      lastWifiScanAttemptMs = millis();
    }
    return;
  }

  if (manualWifiProvisioning &&
      (wifiState == WIFI_WAIT_SELECTION || wifiState == WIFI_WAIT_PASSWORD) &&
      millis() - manualWifiStartMs >= WIFI_PROVISION_TIMEOUT_MS) {
    Serial.println("Wi-Fi setup timed out; returning to automatic recovery.");
    manualWifiProvisioning = false;
    wifiState = WIFI_IDLE;
    pendingPassword = "";
    pendingSSID = "";
    wifiNextRetryDueMs = wifiUptimeMs();
    lastWifiScanAttemptMs = millis();
  }

  if (wifiState != WIFI_IDLE || manualWifiProvisioning) return;

  if (savedWifiCount > 0) {
    if (!wifiOutageActive) beginWifiOutage();
    uint64_t now = wifiUptimeMs();
    if (!wifiRetryCycleActive && now >= wifiNextRetryDueMs) {
      wifiRetryCycleActive = true;
      nextKnownWifiOffset = 0;
      ++wifiRetryCycleNumber;
      wifiNextRetryDueMs = wifiOutageStartMs + wifiRetryOffsetMs(wifiRetryCycleNumber);
      while (wifiNextRetryDueMs <= now) {
        ++wifiRetryCycleNumber;
        wifiNextRetryDueMs = wifiOutageStartMs + wifiRetryOffsetMs(wifiRetryCycleNumber);
      }
      Serial.printf("Trying %d saved Wi-Fi network(s).\n", savedWifiCount);
    }

    while (wifiRetryCycleActive && nextKnownWifiOffset < savedWifiCount) {
      int index = (preferredWifiIndex + nextKnownWifiOffset) % savedWifiCount;
      ++nextKnownWifiOffset;
      currentKnownWifiIndex = index;
      if (startWifiConnection(savedWifiSSIDs[index], savedWifiPasswords[index], false)) return;
      currentKnownWifiIndex = -1;
    }
    if (wifiRetryCycleActive) {
      wifiRetryCycleActive = false;
      Serial.println("Saved networks unavailable. Will retry on schedule; SD logging continues.");
    }
  } else if (lastWifiScanAttemptMs == 0 ||
             millis() - lastWifiScanAttemptMs >= WIFI_SCAN_RETRY_MS) {
    startWifiScan();
  }
}


/***************************************************************
 * Component initialization / recovery
 ***************************************************************/
bool tryInitRtc() {
  if (!rtc.begin()) {
    rtcOk = false;
    rtcTimeTrusted = false;
    rtcHealth = "NOT FOUND";
    Serial.println("RTC not detected.");
    return false;
  }
  rtcOk = true;
  DateTime rtcNow = rtc.now();
  rtcTimeTrusted = !rtc.lostPower() && validLoggerTime(rtcNow);
  if (rtcTimeTrusted) {
    setTrustedTimeAnchor(rtcNow);
    rtcHealth = "OK";
  } else {
    rtcHealth = "TIME UNVERIFIED";
    // If NTP or manual time was verified earlier in this boot, repair the RTC.
    DateTime trustedNow;
    if (getTrustedLogTime(trustedNow)) {
      rtc.adjust(trustedNow);
      DateTime readBack = rtc.now();
      rtcTimeTrusted = validLoggerTime(readBack) &&
          llabs(static_cast<int64_t>(readBack.unixtime()) - trustedNow.unixtime()) <= 2;
      if (rtcTimeTrusted) rtcHealth = "OK";
    } else {
      // Approximate time allows certificate validation to be attempted, but it
      // must never be used to name a weekly CSV or timestamp cloud telemetry.
      DateTime compileTime(F(__DATE__), F(__TIME__));
      uint32_t lastActive = rtcPreferences.getULong("lastTime", 0);
      DateTime fallback = compileTime;
      if (lastActive > compileTime.unixtime()) fallback = DateTime(lastActive);
      rtc.adjust(fallback);
      Serial.println("RTC fallback is approximate; SD rows use a recovery CSV until time is verified.");
    }
  }
  return true;
}

bool tryInitSps30() {
  sensirion_i2c_init();
  if (sps30_probe() != 0) {
    sps30Initialized = false;
    sps30Health = "NOT FOUND";
    return false;
  }

  sps30_set_fan_auto_cleaning_interval_days(1);
  int16_t ret = sps30_start_measurement();
  if (ret < 0) {
    sps30Initialized = false;
    sps30Health = "START FAILED";
    return false;
  }

  sps30Initialized = true;
  sps30Health = sps30HasValidData ? "OK" : "WAITING FOR DATA";
  return true;
}

bool tryInitSht3x() {
  sht3x.begin(Wire, SHT3X_I2C_ADDRESS);
  sht3x.stopMeasurement();
  delay(1);
  sht3x.softReset();
  delay(100);
  sht3x.disableHeater();
  uint16_t status = 0;
  sht3xError = sht3x.readStatusRegister(status);
  if (sht3xError != NO_ERROR) {
    sht3xInitialized = false;
    sht3xHealth = "NOT FOUND";
    return false;
  }

  sht3xInitialized = true;
  sht3xHealth = sht3xHasValidData ? "OK" : "WAITING FOR DATA";
  return true;
}

bool tryInitSd() {
  if (!SD.begin(SD_CS_PIN, SPI, SD_SPI_FREQUENCY_HZ)) {
    sdReady = false;
    sdLastWriteOk = false;
    sdHealth = "SD NOT FOUND";
    return false;
  }

  DateTime trustedNow;
  const bool weekly = getTrustedLogTime(trustedNow);
  String path = weekly ? getWeeklyLogFilePath(trustedNow)
                       : getRecoveryLogFilePath();
  File f = SD.open(path.c_str(), FILE_APPEND);
  if (!f) {
    sdReady = false;
    sdLastWriteOk = false;
    sdHealth = "FILE OPEN FAILED";
    SD.end();
    return false;
  }

  if (f.size() == 0) {
    f.println(weekly ? WEEKLY_CSV_HEADER : RECOVERY_CSV_HEADER);
    f.flush();
  }
  currentLogFileSizeBytes = (uint64_t)f.size();
  f.close();

  sdReady = true;
  sdHealth = weekly ? "READY - WAITING FOR WRITE" : "READY - RECOVERY MODE";
  return true;
}

void serviceComponentRecovery() {
  unsigned long ms = millis();
  if (ms - lastRecoveryAttemptMs < COMPONENT_RECOVERY_INTERVAL_MS) return;
  lastRecoveryAttemptMs = ms;

  if (!displayOk) {
    displayOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
    if (displayOk) {
      display.cp437(true);
      displayNeedsRefresh = true;
    }
  }

  if (!rtcOk) tryInitRtc();
  if (!sps30Initialized) tryInitSps30();
  if (!sht3xInitialized) tryInitSht3x();
  if (!sdReady) tryInitSd();
}

/***************************************************************
 * Sensor services
 ***************************************************************/
void serviceSps30() {
  if (!sps30Initialized) return;
  unsigned long ms = millis();

  // Poll data-ready frequently, but only accept a new SPS30 sample after the
  // configured read interval has elapsed. If the first ready check is a few
  // milliseconds early, subsequent 100 ms polls catch it instead of waiting
  // an entire additional sampling interval.
  if (ms - lastSps30PollMs < SENSOR_READY_POLL_INTERVAL_MS) return;
  lastSps30PollMs = ms;

  if (sps30HasValidData &&
      (ms - lastSps30SampleMs < SPS30_READ_INTERVAL)) {
    return;
  }

  uint16_t dataReady = 0;
  int16_t ret = sps30_read_data_ready(&dataReady);
  if (ret < 0) {
    Serial.println("SPS30 data-ready error: " + String(ret));
    return;
  }

  if (!dataReady) return;

  ret = sps30_read_measurement(&measurement);
  if (ret < 0) {
    Serial.println("SPS30 read_measurement error: " + String(ret));
    return;
  }

  sps30HasValidData = true;
  sps30Initialized = true;
  sps30Health = "OK";
  lastSps30SampleMs = ms;
}

void serviceSht3x() {
  if (!sht3xInitialized) return;
  unsigned long ms = millis();
  unsigned long retryInterval = sht3xHasValidData ? SHT3X_READ_INTERVAL : 1000UL;
  if (ms - lastSht3xPollMs < retryInterval) return;
  lastSht3xPollMs = ms;
  float newTemp = NAN;
  float newRh = NAN;
  sht3xError = sht3x.measureSingleShot(REPEATABILITY_HIGH, false, newTemp, newRh);
  if (sht3xError != NO_ERROR) {
    sht3xHealth = "I2C / READ ERROR";
    sht3xPrintError("SHT3x measureSingleShot error: ", sht3xError);
    return;
  }
  if (!isfinite(newTemp) || !isfinite(newRh)) {
    sht3xHealth = "INVALID DATA";
    return;
  }
  temperature = newTemp;
  humidity = newRh;
  sht3xHasValidData = true;
  sht3xInitialized = true;
  sht3xHealth = "OK";
  lastSht3xSampleMs = ms;
}


/***************************************************************
 * Diagnostic helpers
 ***************************************************************/
String firstDiagnosticFault(unsigned long ms) {
  if (!rtcOk) return "RTC NOT FOUND";
  if (!sps30Initialized) return "SPS30 NOT FOUND";
  if (!sps30DataUsable(ms)) return "SPS30 NO DATA";
  if (!sht3xInitialized) return "SHT3x NOT FOUND";
  if (!sht3xDataUsable(ms)) return "SHT3x NO DATA";
  if (!sdReady) return "SD NOT READY";
  if (lastSuccessfulSdWriteMs > 0 && !sdLastWriteOk) return "SD WRITE FAIL";
  return "";
}

/***************************************************************
 * Display service
 ***************************************************************/
unsigned long currentPageDuration() {
  switch (currentDisplay) {
    case SHOW_PM:    return PM_PAGE_INTERVAL;
    case SHOW_NC:    return NC_PAGE_INTERVAL;
    case SHOW_SHT3x: return SHT3X_PAGE_INTERVAL;
    case SHOW_IP:    return IP_PAGE_INTERVAL;
    default:         return 3000UL;
  }
}

void advanceDisplayPageIfNeeded() {
  unsigned long ms = millis();
  if (ms - lastPageToggleMs < currentPageDuration()) return;

  currentDisplay = (DisplayState)(((int)currentDisplay + 1) % 4);
  lastPageToggleMs = ms;
  displayNeedsRefresh = true;
}

void updateOledIfNeeded() {
  if (!startupComplete || !displayOk) return;

  unsigned long ms = millis();
  if (!displayNeedsRefresh && ms - lastOledRefreshMs < OLED_REFRESH_INTERVAL) return;

  // Fault page takes priority. When the fault clears, normal pages resume.
  String fault = firstDiagnosticFault(ms);
  if (fault.length() > 0) {
    lastOledRefreshMs = ms;
    displayNeedsRefresh = false;

    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);

    DateTime now;
    if (getTrustedLogTime(now)) {
      char dateBuffer[11];
      char timeBuffer[9];
      formatRtcDateTime(now, dateBuffer, sizeof(dateBuffer),
                        timeBuffer, sizeof(timeBuffer));
      display.print(dateBuffer);
      display.print(" ");
      display.println(timeBuffer);
    } else {
      display.println("TIME UNVERIFIED");
    }

    display.setCursor(0, 16);
    display.println("SYSTEM ERROR");

    if (fault.length() <= 9) {
      display.setTextSize(2);
      display.setCursor(0, 28);
      display.println(fault);
    } else {
      display.setTextSize(1);
      display.setCursor(0, 30);
      display.println(fault);
    }

    display.setTextSize(1);
    display.setCursor(0, 52);
    if (!rtcOk) {
      display.print("Check RTC power/I2C");
    } else if (!sps30Initialized || !sps30DataUsable(ms)) {
      display.print("Check SPS30 power/I2C");
    } else if (!sht3xInitialized || !sht3xDataUsable(ms)) {
      display.print("Check SHT3x power/I2C");
    } else {
      display.print("Check SD card");
    }

    display.display();
    return;
  }

  lastOledRefreshMs = ms;
  displayNeedsRefresh = false;

  DateTime now;
  const bool timeVerified = getTrustedLogTime(now);
  char dateBuffer[11];
  char timeBuffer[9];
  if (timeVerified) {
    formatRtcDateTime(now, dateBuffer, sizeof(dateBuffer),
                      timeBuffer, sizeof(timeBuffer));
  }

  display.clearDisplay();
  display.setCursor(0, 0);
  display.setTextSize(1);
  display.setTextColor(SSD1306_WHITE);
  if (timeVerified) {
    display.print(dateBuffer);
    display.print(" ");
    display.println(timeBuffer);
  } else {
    display.println("TIME UNVERIFIED");
  }

  switch (currentDisplay) {
    case SHOW_PM:
      display.setCursor(0, 16);
      display.println("PM Values [ug/m3]");
      if (!sps30HasValidData) {
        display.println("Waiting for SPS30");
      } else {
        display.print("PM1.0 : "); display.println(measurement.mc_1p0, 2);
        display.print("PM2.5 : "); display.println(measurement.mc_2p5, 2);
        display.print("PM4.0 : "); display.println(measurement.mc_4p0, 2);
        display.print("PM10.0: "); display.println(measurement.mc_10p0, 2);
      }
      break;

    case SHOW_NC:
      display.setCursor(0, 16);
#ifndef SPS30_LIMITED_I2C_BUFFER_SIZE
      display.println("NC [particles/cm3]");
      if (!sps30HasValidData) {
        display.println("Waiting for SPS30");
      } else {
        display.print("NC0.5 : "); display.println(measurement.nc_0p5, 2);
        display.print("NC1.0 : "); display.println(measurement.nc_1p0, 2);
        display.print("NC2.5 : "); display.println(measurement.nc_2p5, 2);
        display.print("NC4.0 : "); display.println(measurement.nc_4p0, 2);
        display.print("NC10.0: "); display.println(measurement.nc_10p0, 2);
      }
#else
      display.println("NC not supported");
#endif
      break;

    case SHOW_SHT3x:
      display.setCursor(0, 16);
      display.println("SHT3x Values");
      if (!sht3xHasValidData) {
        display.println("Waiting for SHT3x");
      } else {
        display.print("Temp: ");
        display.print(temperature, 2);
        display.write(248);
        display.println("C");

        display.print("RH  : ");
        display.print(humidity, 2);
        display.println(" %");
      }
      break;

    case SHOW_IP:
      display.setCursor(0, 16);
      if (connected) {
        display.println("Wi-Fi: Connected");
        display.print("IP: ");
        display.println(WiFi.localIP().toString());
        display.print("RSSI: ");
        display.print(WiFi.RSSI());
        display.println(" dBm");
        display.print("Cloud: ");
        if (!cloudConfigured()) display.println("NOT CONFIG");
        else if (remoteUploadState != REMOTE_UPLOAD_IDLE) display.println("UPLOADING");
        else if (lastCloudSuccessMs > 0 && millis() - lastCloudSuccessMs < 180000UL) display.println("OK");
        else display.println("WAITING");
      } else {
        display.println("Wi-Fi: NOT connected");
        display.println("Logging continues");
        display.println("Cloud: OFFLINE");
      }
      break;
  }

  display.display();
}

/***************************************************************
 * SD logging service
 ***************************************************************/
void appendRecoveryTimeAnchor(const DateTime& verifiedNow, uint64_t uptimeMs) {
  if (!unsyncedAwaitingAnchor || !sdReady) return;
  String path = getRecoveryLogFilePath();
  File recovery = SD.open(path.c_str(), FILE_APPEND);
  if (!recovery) return;

  char dateBuffer[11], timeBuffer[9];
  formatRtcDateTime(verifiedNow, dateBuffer, sizeof(dateBuffer),
                    timeBuffer, sizeof(timeBuffer));
  char anchorRow[128];
  int anchorLength = snprintf(anchorRow, sizeof(anchorRow),
                              "SYNC,%llu,%s,%s,,,,,,,,,,,,,\n",
                              static_cast<unsigned long long>(uptimeMs),
                              dateBuffer, timeBuffer);
  size_t written = (anchorLength > 0 && anchorLength < static_cast<int>(sizeof(anchorRow)))
      ? recovery.write(reinterpret_cast<const uint8_t*>(anchorRow), anchorLength) : 0;
  recovery.flush();
  recovery.close();
  if (anchorLength > 0 && written == static_cast<size_t>(anchorLength)) {
    unsyncedAwaitingAnchor = false;
    Serial.println("Recovery CSV time-anchored. Raw readings preserved for reconstruction.");
  }
}

void serviceSdLogging() {
  unsigned long ms = millis();
  if (ms - lastLogMs < LOG_INTERVAL) return;
  lastLogMs = ms;

  // Logging is independent of Wi-Fi, RTC and individual sensor availability.
  // Without verified absolute time, write an uptime-stamped recovery row.
  DateTime now;
  const bool weekly = getTrustedLogTime(now);
  const uint64_t uptimeMs = static_cast<uint64_t>(esp_timer_get_time()) / 1000ULL;
  if (weekly) appendRecoveryTimeAnchor(now, uptimeMs);
  char dateBuffer[11] = "";
  char timeBuffer[9] = "";
  if (weekly) {
    formatRtcDateTime(now, dateBuffer, sizeof(dateBuffer),
                      timeBuffer, sizeof(timeBuffer));
  }

  // IMPORTANT: SD rows are on their own fixed time grid. If the SD interval is
  // shorter than a sensor's sampling interval, the latest valid sensor value is
  // intentionally repeated until the next real sensor measurement arrives.
  // This is a zero-order hold and avoids false NaNs caused solely by timer phase.
  // NaN is reserved for a genuinely stale sensor (no update for >3 expected
  // sample periods + margin), which indicates a real acquisition problem.
  bool spsUsable = sps30DataUsable(ms);
  bool shtUsable = sht3xDataUsable(ms);

  float pm1   = spsUsable ? measurement.mc_1p0 : NAN;
  float pm25  = spsUsable ? measurement.mc_2p5 : NAN;
  float pm4   = spsUsable ? measurement.mc_4p0 : NAN;
  float pm10  = spsUsable ? measurement.mc_10p0 : NAN;
  float nc05  = spsUsable ? measurement.nc_0p5 : NAN;
  float nc1   = spsUsable ? measurement.nc_1p0 : NAN;
  float nc25  = spsUsable ? measurement.nc_2p5 : NAN;
  float nc4   = spsUsable ? measurement.nc_4p0 : NAN;
  float nc10  = spsUsable ? measurement.nc_10p0 : NAN;
  float psize = spsUsable ? measurement.typical_particle_size : NAN;

  float temp = shtUsable ? temperature : NAN;
  float rh   = shtUsable ? humidity : NAN;

  char values[256];
  int valueLength = snprintf(
      values, sizeof(values),
      "%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f",
      pm1, pm25, pm4, pm10, nc05, nc1, nc25, nc4, nc10, psize, temp, rh);
  if (valueLength < 0 || valueLength >= static_cast<int>(sizeof(values))) {
    sdLastWriteOk = false;
    sdHealth = "ROW FORMAT FAILED";
    return;
  }

  char row[384];
  int rowLength = weekly
      ? snprintf(row, sizeof(row), "%s,%s,%s\n", dateBuffer, timeBuffer, values)
      : snprintf(row, sizeof(row), "DATA,%llu,,,%s\n",
                 static_cast<unsigned long long>(uptimeMs), values);
  if (rowLength <= 0 || rowLength >= static_cast<int>(sizeof(row))) {
    sdLastWriteOk = false;
    sdHealth = "ROW FORMAT FAILED";
    return;
  }

  String path = weekly ? getWeeklyLogFilePath(now) : getRecoveryLogFilePath();
  File f = SD.open(path.c_str(), FILE_APPEND);
  if (f) {
    if (f.size() == 0) {
      f.println(weekly ? WEEKLY_CSV_HEADER : RECOVERY_CSV_HEADER);
      f.flush();
    }

    size_t written = f.write(reinterpret_cast<const uint8_t*>(row), rowLength);

    f.flush();
    currentLogFileSizeBytes = (uint64_t)f.size();
    f.close();

    if (written == static_cast<size_t>(rowLength)) {
      sdReady = true;
      sdLastWriteOk = true;
      sdHealth = weekly ? "LOGGING" : "LOGGING - TIME UNVERIFIED";
      lastSuccessfulSdWriteMs = ms;
      if (!weekly) unsyncedAwaitingAnchor = true;
    } else {
      sdLastWriteOk = false;
      sdHealth = "WRITE FAILED";
    }

    // Two beeps mean a real CSV row has successfully reached the SD card.
    if (written == static_cast<size_t>(rowLength) && !firstSuccessfulLogBeepDone) {
      firstSuccessfulLogBeepDone = true;
      buzzerLoggingReadyDoubleBeep();
      Serial.println("BEEP BEEP: First SD row written; logging confirmed.");
    }
  } else {
    sdReady = false;
    sdLastWriteOk = false;
    sdHealth = "FILE OPEN FAILED";
    Serial.println("Failed to open " + path + " for appending.");
  }

  if ((!spsUsable || !shtUsable) &&
      (lastMissingSensorWarningMs == 0 ||
       ms - lastMissingSensorWarningMs >= 30000UL)) {
    lastMissingSensorWarningMs = ms;
    Serial.println("One or more sensors unavailable; SD rows continue with NaN in missing fields.");
  }

  // NVS is for occasional recovery checkpoints, not a write on every CSV row.
  if (weekly && (lastRtcCheckpointMs == 0 ||
                 ms - lastRtcCheckpointMs >= RTC_CHECKPOINT_INTERVAL_MS)) {
    rtcPreferences.putULong("lastTime", now.unixtime());
    lastRtcCheckpointMs = ms;
  }
}

/***************************************************************
 * Remote cloud dashboard services
 ***************************************************************/
void sendCloudHeartbeat() {
  LoggerStateLock guard;
  DateTime trustedNow;
  if (!getTrustedLogTime(trustedNow)) return;
  String body = "{";
  body += "\"device_id\":\"" + jsonEscape(CLOUD_DEVICE_ID) + "\"";
  body += ",\"timestamp\":\"" + jsonEscape(iso8601FromRtc()) + "\"";
  body += ",\"rssi\":" + String(connected ? WiFi.RSSI() : -127);
  body += ",\"sd_ok\":" + String(sdReady && sdLastWriteOk ? "true" : "false");
  body += ",\"sps30_ok\":" + String(sps30DataUsable(millis()) ? "true" : "false");
  body += ",\"sht3x_ok\":" + String(sht3xDataUsable(millis()) ? "true" : "false");
  body += ",\"rtc_ok\":" + String(rtcOk ? "true" : "false");
  body += ",\"current_file\":\"" + jsonEscape(getLogDownloadName()) + "\"";
  body += ",\"current_file_size\":" + String((uint32_t)currentLogFileSizeBytes);
  body += ",\"firmware_version\":\"" + jsonEscape(FIRMWARE_VERSION) + "\"";
  body += "}";

  guard.unlock();
  int code = cloudPost("device-heartbeat", body);
  if (code >= 200 && code < 300) {
    Serial.println("Cloud heartbeat OK.");
  }
}

void sendCloudTelemetry() {
  LoggerStateLock guard;
  DateTime trustedNow;
  if (!getTrustedLogTime(trustedNow)) return;
  unsigned long ms = millis();
  bool spsOk = sps30DataUsable(ms);
  bool shtOk = sht3xDataUsable(ms);

  String body = "{";
  body += "\"device_id\":\"" + jsonEscape(CLOUD_DEVICE_ID) + "\"";
  body += ",\"timestamp\":\"" + jsonEscape(iso8601FromRtc()) + "\"";
  body += ",\"pm1\":" + jsonFloatOrNull(measurement.mc_1p0,
    spsOk && measurement.mc_1p0 >= 0 && measurement.mc_1p0 <= 10000);
  body += ",\"pm25\":" + jsonFloatOrNull(measurement.mc_2p5, spsOk);
  body += ",\"pm10\":" + jsonFloatOrNull(measurement.mc_10p0, spsOk);
  body += ",\"temperature\":" + jsonFloatOrNull(temperature, shtOk);
  body += ",\"rh\":" + jsonFloatOrNull(humidity, shtOk);
  body += "}";

  guard.unlock();
  int code = cloudPost("device-telemetry", body);
  if (code >= 200 && code < 300) {
    Serial.println("5-minute cloud telemetry OK.");
  }
}

void cloudAckCommand(const String& commandId, const String& status,
                     const String& errorMessage = "") {
  if (commandId.length() == 0) return;
  String body = "{";
  body += "\"device_id\":\"" + jsonEscape(CLOUD_DEVICE_ID) + "\"";
  body += ",\"command_id\":\"" + jsonEscape(commandId) + "\"";
  body += ",\"status\":\"" + jsonEscape(status) + "\"";
  if (errorMessage.length() > 0) {
    body += ",\"error_message\":\"" + jsonEscape(errorMessage) + "\"";
  }
  body += "}";
  cloudPost("device-command-ack", body);
}

// The Arduino SD File API exposes modification time, not creation time.
// Each logger CSV starts with a header followed by its first RTC-stamped row;
// that first reading marks when this logger started writing the file.
String fileCreatedAtFromFirstReading(File& file) {
  if (!file.seek(0)) return "";
  char header[160];
  char firstRow[48];
  if (file.readBytesUntil('\n', header, sizeof(header) - 1) == 0) return "";
  const size_t firstLength =
      file.readBytesUntil('\n', firstRow, sizeof(firstRow) - 1);
  if (firstLength == 0) return "";
  firstRow[firstLength] = '\0';

  unsigned day, month, year, hour, minute, second;
  if (sscanf(firstRow, "%u-%u-%u,%u:%u:%u,", &day, &month, &year,
             &hour, &minute, &second) != 6 ||
      year < 2024 || year > 2099 || month < 1 || month > 12 ||
      day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return "";
  }
  DateTime firstReading(year, month, day, hour, minute, second);
  if (!firstReading.isValid()) return "";

  const time_t nowEpoch = time(nullptr);
  const int64_t firstUtc =
      (int64_t)firstReading.unixtime() - (int64_t)NTP_UTC_OFFSET_SECONDS;
  if (nowEpoch < 1704067200 || firstUtc > (int64_t)nowEpoch + 86400) {
    return "";
  }

  char createdIso[26];
  snprintf(createdIso, sizeof(createdIso), "%04u-%02u-%02uT%02u:%02u:%02u+05:30",
           year, month, day, hour, minute, second);
  return String(createdIso);
}

bool sendCloudFileCatalog(const String& commandId) {
  LoggerStateLock guard;
  if (!sdReady) return false;

  String body = "{";
  body += "\"device_id\":\"" + jsonEscape(CLOUD_DEVICE_ID) + "\"";
  body += ",\"command_id\":\"" + jsonEscape(commandId) + "\"";
  body += ",\"files\":[";

  File root = SD.open("/");
  if (!root || !root.isDirectory()) {
    if (root) root.close();
    return false;
  }

  bool first = true;
  int count = 0;
  File entry = root.openNextFile();
  while (entry && count < 100) {
    String name = entry.name();
    if (name.startsWith("/")) name.remove(0, 1);
    if (!entry.isDirectory() && safeCsvFilename(name)) {
      if (!first) body += ',';
      first = false;
      body += "{\"name\":\"" + jsonEscape(name) + "\",\"size_bytes\":";
      body += String((uint32_t)entry.size());
      String createdAt = fileCreatedAtFromFirstReading(entry);
      if (createdAt.length() > 0) {
        body += ",\"created_at\":\"";
        body += createdAt;
        body += "\"";
      }
      body += "}";
      ++count;
    }
    entry.close();
    entry = root.openNextFile();
  }
  if (entry) entry.close();
  root.close();
  body += "]}";

  guard.unlock();
  int code = cloudPost("device-file-catalog", body);
  return code >= 200 && code < 300;
}

void finishRemoteUpload(bool success, const String& errorMessage = "") {
  { LoggerStateLock guard; if (remoteUploadFile) remoteUploadFile.close(); }
  remoteUploadClient.stop();

  String body = "{";
  body += "\"device_id\":\"" + jsonEscape(CLOUD_DEVICE_ID) + "\"";
  body += ",\"command_id\":\"" + jsonEscape(remoteUploadCommandId) + "\"";
  if (remoteUploadRequestId.length() > 0) {
    body += ",\"request_id\":\"" + jsonEscape(remoteUploadRequestId) + "\"";
  }
  body += ",\"filename\":\"" + jsonEscape(remoteUploadFilename) + "\"";
  body += ",\"bytes_uploaded\":" + String((uint32_t)remoteUploadSentBytes);
  body += ",\"status\":\"" + String(success ? "ready" : "failed") + "\"";
  if (errorMessage.length() > 0) {
    body += ",\"error\":\"" + jsonEscape(errorMessage) + "\"";
  }
  body += "}";

  int completionCode = cloudPost(success ? "device-download-complete" : "device-download-failed", body);
  for (int retry = 0; retry < 2 && (completionCode < 0 || completionCode >= 500); ++retry) {
    vTaskDelay(pdMS_TO_TICKS(500 * (retry + 1)));
    completionCode = cloudPost(success ? "device-download-complete" : "device-download-failed", body);
  }
  // Completion endpoints own both request and command transitions. Do not mark
  // the command completed if storage verification or the HTTP request failed.
  if (completionCode < 200 || completionCode >= 300) {
    Serial.println("Cloud finalization failed; transfer was not confirmed ready.");
    if (success) {
      String failure = "{\"request_id\":\"" + jsonEscape(remoteUploadRequestId) +
        "\",\"error\":\"Could not confirm uploaded object\"}";
      cloudPost("device-download-failed", failure);
    }
  }

  Serial.print("Remote CSV upload ");
  Serial.println(success && completionCode >= 200 && completionCode < 300 ? "completed and verified." : "failed or unconfirmed.");

  { LoggerStateLock guard; remoteUploadState = REMOTE_UPLOAD_IDLE; }
  remoteUploadCommandId = "";
  remoteUploadRequestId = "";
  remoteUploadFilename = "";
  remoteUploadTotalBytes = 0;
  remoteUploadSentBytes = 0;
  remoteUploadHttpCode = 0;
  remoteUploadLastProgressBucket = 255;
}

bool startRemoteFileUpload(const String& commandId, const String& requestId,
                           const String& filename, const String& uploadUrl,
                           String method, uint64_t snapshotBytes) {
  if (remoteUploadState != REMOTE_UPLOAD_IDLE || !safeCsvFilename(filename)) return false;

  String path = "/" + filename;
  File f;
  {
    LoggerStateLock guard;
    f = SD.open(path.c_str(), FILE_READ);
    if (!f) return false;
    if ((uint64_t)f.size() < snapshotBytes) { f.close(); return false; }
  }

  String host, urlPath;
  uint16_t port = 443;
  if (!parseHttpsUrl(uploadUrl, host, port, urlPath)) {
    LoggerStateLock guard;
    f.close();
    return false;
  }

  method.toUpperCase();
  if (method != "PUT" && method != "POST") method = "PUT";

  remoteUploadClient.stop();
  remoteUploadClient.useBuiltinCACertBundle();
  remoteUploadClient.setHandshakeTimeout(8);
  remoteUploadClient.setTimeout(1000);

  if (!remoteUploadClient.connect(host.c_str(), port)) {
    LoggerStateLock guard;
    f.close();
    return false;
  }

  remoteUploadFile = f;
  remoteUploadCommandId = commandId;
  remoteUploadRequestId = requestId;
  remoteUploadFilename = filename;
  remoteUploadMethod = method;
  remoteUploadHost = host;
  remoteUploadPath = urlPath;
  remoteUploadPort = port;
  remoteUploadTotalBytes = snapshotBytes;
  remoteUploadSentBytes = 0;
  remoteUploadLastActivityMs = millis();
  remoteUploadHttpCode = 0;
  remoteUploadLastProgressBucket = 255;

  remoteUploadClient.print(remoteUploadMethod);
  remoteUploadClient.print(" ");
  remoteUploadClient.print(remoteUploadPath);
  remoteUploadClient.println(" HTTP/1.1");
  remoteUploadClient.print("Host: "); remoteUploadClient.println(remoteUploadHost);
  remoteUploadClient.println("Content-Type: text/csv");
  remoteUploadClient.print("Content-Length: ");
  remoteUploadClient.println(String((uint32_t)remoteUploadTotalBytes));
  remoteUploadClient.println("Connection: close");
  remoteUploadClient.println();

  { LoggerStateLock guard;
    remoteUploadState = REMOTE_UPLOAD_SENDING;
    cloudHealth = "CSV UPLOAD ACTIVE";
  }
  Serial.print("Remote CSV upload started: ");
  Serial.print(filename);
  Serial.print(" (bytes: ");
  Serial.print((uint32_t)remoteUploadTotalBytes);
  Serial.println(")");
  return true;
}

bool requestRemoteUploadSession(const String& commandId, const String& requestId,
                                const String& filename) {
  LoggerStateLock guard;
  if (!safeCsvFilename(filename) || !sdReady) return false;
  String path = "/" + filename;
  File f = SD.open(path.c_str(), FILE_READ);
  if (!f) return false;
  uint64_t fileSize = (uint64_t)f.size();
  f.close();
  guard.unlock();
  if (fileSize == 0 || fileSize > 104857600ULL) return false;

  String body = "{";
  body += "\"device_id\":\"" + jsonEscape(CLOUD_DEVICE_ID) + "\"";
  body += ",\"command_id\":\"" + jsonEscape(commandId) + "\"";
  if (requestId.length() > 0) {
    body += ",\"request_id\":\"" + jsonEscape(requestId) + "\"";
  }
  body += ",\"filename\":\"" + jsonEscape(filename) + "\"";
  body += ",\"total_bytes\":" + String((uint32_t)fileSize);
  body += "}";

  String response;
  int code = cloudPost("device-upload-session", body, &response);
  if (code < 200 || code >= 300) return false;

  String uploadUrl = jsonStringValue(response, "upload_url");
  if (uploadUrl.length() == 0) uploadUrl = jsonStringValue(response, "signed_url");
  String method = jsonStringValue(response, "upload_method");
  if (method.length() == 0) method = "PUT";
  String returnedRequestId = jsonStringValue(response, "request_id");
  if (returnedRequestId.length() == 0) returnedRequestId = requestId;

  if (uploadUrl.length() == 0) {
    Serial.println("Upload session response did not contain upload_url/signed_url.");
    return false;
  }

  return startRemoteFileUpload(commandId, returnedRequestId, filename, uploadUrl, method, fileSize);
}

void serviceRemoteFileUpload() {
  if (remoteUploadState == REMOTE_UPLOAD_IDLE) return;

  unsigned long ms = millis();
  if (ms - remoteUploadLastActivityMs > REMOTE_UPLOAD_STALL_TIMEOUT_MS) {
    finishRemoteUpload(false, "Upload stalled or timed out");
    return;
  }

  if (remoteUploadState == REMOTE_UPLOAD_SENDING) {
    if (!remoteUploadClient.connected() && remoteUploadSentBytes < remoteUploadTotalBytes) {
      finishRemoteUpload(false, "TLS connection closed during upload");
      return;
    }

    static uint8_t buffer[REMOTE_UPLOAD_CHUNK_BYTES];
    uint64_t remaining = remoteUploadTotalBytes - remoteUploadSentBytes;
    size_t requested = remaining < sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
    size_t got = 0;
    { LoggerStateLock guard; if (requested) got = remoteUploadFile.read(buffer, requested); }
    if (requested && got == 0) { finishRemoteUpload(false, "SD read ended before snapshot size"); return; }
    if (got > 0) {
      size_t offset = 0;
      while (offset < got) {
        size_t sent = remoteUploadClient.write(buffer + offset, got - offset);
        if (sent == 0) {
          finishRemoteUpload(false, "Socket write failed");
          return;
        }
        offset += sent;
      }
      remoteUploadSentBytes += got;
      remoteUploadLastActivityMs = ms;

      if (remoteUploadTotalBytes > 0) {
        uint8_t pct = (uint8_t)((remoteUploadSentBytes * 100ULL) / remoteUploadTotalBytes);
        uint8_t bucket = pct / 10;
        if (bucket != remoteUploadLastProgressBucket) {
          remoteUploadLastProgressBucket = bucket;
          Serial.print("Remote CSV upload: "); Serial.print(pct); Serial.println("%");
          String progress = "{\"request_id\":\"" + jsonEscape(remoteUploadRequestId) +
            "\",\"bytes_uploaded\":" + String((uint32_t)remoteUploadSentBytes) +
            ",\"total_bytes\":" + String((uint32_t)remoteUploadTotalBytes) + "}";
          int progressCode = cloudPost("device-download-progress", progress);
          if (progressCode == 404 || progressCode == 409) {
            finishRemoteUpload(false, "Download cancelled or expired");
            return;
          }
        }
      }
      return; // one small SD/network chunk per loop iteration
    }

    { LoggerStateLock guard;
      remoteUploadFile.close();
      remoteUploadState = REMOTE_UPLOAD_WAIT_RESPONSE;
    }
    remoteUploadLastActivityMs = ms;
    return;
  }

  if (remoteUploadState == REMOTE_UPLOAD_WAIT_RESPONSE) {
    while (remoteUploadClient.available()) {
      String line = remoteUploadClient.readStringUntil('\n');
      line.trim();
      remoteUploadLastActivityMs = ms;
      if (line.startsWith("HTTP/")) {
        int firstSpace = line.indexOf(' ');
        if (firstSpace > 0) remoteUploadHttpCode = line.substring(firstSpace + 1).toInt();
      }
    }

    if (!remoteUploadClient.connected() && !remoteUploadClient.available()) {
      bool ok = remoteUploadHttpCode >= 200 && remoteUploadHttpCode < 300;
      finishRemoteUpload(ok, ok ? "" : (String("Upload HTTP ") + remoteUploadHttpCode));
    }
  }
}

void pollCloudCommands() {
  if (remoteUploadState != REMOTE_UPLOAD_IDLE) return;
  String response;
  int code = cloudGet("device-next-command", &response);
  if (code == 204 ||
      (code >= 200 && code < 300 && response.indexOf("\"command\":null") >= 0)) {
    return;
  }
  if (code < 200 || code >= 300) return;

  String commandId = jsonStringValue(response, "command_id");
  String command = jsonStringValue(response, "command");
  if (command.length() == 0) command = jsonStringValue(response, "command_type");
  String filename = jsonStringValue(response, "filename");
  String requestId = jsonStringValue(response, "request_id");

  if (command.length() == 0) return;
  Serial.print("Cloud command received: "); Serial.println(command);
  cloudAckCommand(commandId, "acknowledged");

  if (command == "list_files") {
    bool ok = sendCloudFileCatalog(commandId);
    cloudAckCommand(commandId, ok ? "completed" : "failed",
                    ok ? "" : "Could not read/send SD file catalog");
    return;
  }

  if (command == "download_file") {
    if (!safeCsvFilename(filename)) {
      cloudAckCommand(commandId, "failed", "Invalid CSV filename");
      return;
    }
    cloudAckCommand(commandId, "running");
    if (!requestRemoteUploadSession(commandId, requestId, filename)) {
      String failure = "{\"request_id\":\"" + jsonEscape(requestId) +
        "\",\"error\":\"Could not create or start upload session\"}";
      cloudPost("device-download-failed", failure);
      cloudAckCommand(commandId, "failed", "Could not create/start upload session");
    }
    return;
  }

  cloudAckCommand(commandId, "failed", "Unsupported command");
}

void serviceCloudDashboard() {
  // Always service an active streaming file transfer first. It sends only one
  // small chunk per loop call, allowing the normal logger services to keep running.
  serviceRemoteFileUpload();

  { LoggerStateLock guard;
  if (!cloudConfigured()) {
    cloudHealth = "NOT CONFIGURED";
    return;
  }
  if (!connected) {
    cloudHealth = "WAITING FOR WIFI";
    return;
  }
  }

  unsigned long ms = millis();

  // Keep the signed upload socket as the only cloud network transaction while
  // streaming, so progress updates cannot compete with command polling.
  if (remoteUploadState != REMOTE_UPLOAD_IDLE) return;

  // At most one cloud transaction per worker pass.
  if (lastCloudHeartbeatMs == 0 ||
      ms - lastCloudHeartbeatMs >= CLOUD_HEARTBEAT_INTERVAL_MS) {
    lastCloudHeartbeatMs = ms;
    sendCloudHeartbeat();
    return;
  }

  if (lastCloudTelemetryMs == 0 ||
      ms - lastCloudTelemetryMs >= CLOUD_TELEMETRY_INTERVAL_MS) {
    lastCloudTelemetryMs = ms;
    sendCloudTelemetry();
    return;
  }

  if (lastCloudCommandPollMs == 0 ||
      ms - lastCloudCommandPollMs >= CLOUD_COMMAND_POLL_INTERVAL_MS) {
    lastCloudCommandPollMs = ms;
    pollCloudCommands();
  }
}

void cloudWorker(void*) {
  for (;;) {
    serviceCloudDashboard();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

/***************************************************************
 * Setup
 ***************************************************************/
void setup() {
  loggerStateMutex = xSemaphoreCreateRecursiveMutex();
  Serial.begin(115200);
  Serial.setTimeout(50);
  delay(200);
  Serial.println("Starting diagnostic PM + temperature/RH data logger...");

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  buzzerStartupBeep();

  loadIntervalsFromPrefs();

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(100000);
  Wire.setTimeOut(50);

  pinMode(SD_CS_PIN, OUTPUT);
  digitalWrite(SD_CS_PIN, HIGH);
  SPI.begin(SD_SCK, SD_MISO, SD_MOSI, SD_CS_PIN);

  // OLED is non-blocking for diagnostics.
  displayOk = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDRESS);
  if (displayOk) {
    display.cp437(true);
    showStartupScreen("OLED OK", "Checking hardware...");
  } else {
    Serial.println("OLED NOT FOUND. Continuing so web diagnostics can still run.");
  }

  rtcPreferences.begin("rtcTime", false);
  bootSequence = rtcPreferences.getULong("bootSeq", 0) + 1;
  if (bootSequence == 0) bootSequence = 1;
  rtcPreferences.putULong("bootSeq", bootSequence);
  bootNonce = esp_random();

  if (tryInitRtc()) {
    // Required before secure IITD PEAP and HTTPS certificate validation.
    syncSystemClockFromRtc();
    showStartupScreen("RTC OK", "Checking SPS30...");
  } else {
    showStartupScreen("RTC NOT FOUND", "Will retry in loop");
  }

  if (tryInitSps30()) {
    showStartupScreen("SPS30 FOUND", "Waiting for data...");
  } else {
    showStartupScreen("SPS30 NOT FOUND", "Will retry in loop");
  }

  if (tryInitSht3x()) {
    showStartupScreen("SHT3x FOUND", "Waiting for data...");
  } else {
    showStartupScreen("SHT3x NOT FOUND", "Will retry in loop");
  }

  if (tryInitSd()) {
    showStartupScreen("SD READY", "Starting services...");
  } else {
    sdReady = false;
    showStartupScreen("SD NOT READY", "Will retry in loop");
  }

  registerWebRoutes();

  WiFi.mode(WIFI_STA);
  WiFi.onEvent([](WiFiEvent_t, WiFiEventInfo_t info) {
    Serial.print("Wi-Fi disconnected (reason code ");
    Serial.print(info.wifi_sta_disconnected.reason);
    Serial.println(").");
  }, ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.setAutoReconnect(false);  // The schedule below owns every retry.
  wifiPrefs.begin("wifiCreds", false);
  loadSavedWifiNetworks();
  if (savedWifiCount > 0) beginWifiOutage();
  Serial.println("Type 'wifi scan' in Serial Monitor to add or switch networks.");

  unsigned long ms = millis();
  lastPageToggleMs = ms;
  lastOledRefreshMs = 0;
  lastSps30PollMs = 0;
  lastSht3xPollMs = 0;
  lastLogMs = ms;
  displayNeedsRefresh = true;
  startupComplete = true;
  lastRecoveryAttemptMs = ms;

  Serial.println("Startup checks complete. Diagnostic mode active; missing components will be retried automatically.");
  Serial.print("mDNS name: ");
  Serial.print(NETWORK_HOSTNAME);
  Serial.println(".local");

  updateOledIfNeeded();
  if (!loggerStateMutex || xTaskCreatePinnedToCore(cloudWorker, "cloud", 16384, nullptr, 1, nullptr, 0) != pdPASS) {
    cloudHealth = "CLOUD TASK UNAVAILABLE";
    Serial.println("Cloud worker unavailable; local logging remains enabled.");
  }
}

/***************************************************************
 * Main loop
 ***************************************************************/
void loop() {
  {
  LoggerStateLock guard;
  serviceComponentRecovery();
  serviceSps30();
  serviceSht3x();
  serviceSdLogging();
  serviceWifi();
  serviceNtpSync();
  advanceDisplayPageIfNeeded();
  updateOledIfNeeded();
  }
  delay(1);
}
