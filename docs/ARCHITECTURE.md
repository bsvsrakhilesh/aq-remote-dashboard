# System architecture

```text
SPS30 + SHT3x + RTC
          │
          ▼
    XIAO ESP32-S3 ─────────► SD card (permanent, full-resolution data)
          │  └─────────────► Local WebServer (existing direct dashboard)
          │
          └── outbound HTTPS over IITD_WIFI
                         │
                         ▼
                 Supabase Edge Functions
                  │       │        │
           PostgreSQL  private   command queue
          (5-min data)  storage   + heartbeats
                  └───────┬────────┘
                          ▼
                  GitHub Pages (React)
                          │
                    phone / laptop
```

The local and remote dashboards are independent. The ESP32's acquisition, RTC, OLED and SD-writing loops remain authoritative and must never wait for cloud work. Remote operations run as best-effort background tasks with bounded timeouts and retries.

The cloud stores five-minute summaries, health, file metadata, and explicitly requested temporary CSV objects only. It is not a permanent mirror. Browser traffic uses Supabase Auth plus RLS. Device traffic reaches narrow Edge Functions using per-device credentials; the service-role key stays server-side.

For future sensors, add nullable measurement columns through a migration and a chart descriptor in the frontend. Do not alter existing device routes or duplicate pages per logger.
