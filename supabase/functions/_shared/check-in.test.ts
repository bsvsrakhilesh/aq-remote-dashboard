import { describe, expect, it } from 'vitest'
import { parseCheckIn } from './check-in'

const receivedAt = '2026-10-12T12:00:00.000Z'
const validCheckIn = {
  timestamp: '2026-10-12T11:59:00Z',
  rssi: -66,
  sd_ok: true,
  sps30_ok: true,
  sht3x_ok: true,
  rtc_ok: true,
  current_file: 'aq_outdoor01_2026-W42.csv',
  current_file_size: 1024,
  firmware_version: 'pm-sht-iitd-cloud-1.2.4',
  telemetry: { pm1: 12, pm25: 18, pm10: 20, temperature: 24, rh: 46 },
}

describe('combined device check-in', () => {
  it('validates and keeps one timestamp for health and telemetry', () => {
    const result = parseCheckIn(validCheckIn, receivedAt)
    expect(result.error).toBeUndefined()
    expect(result.data?.heartbeat.timestamp).toBe(validCheckIn.timestamp)
    expect(result.data?.telemetry).toMatchObject({ timestamp: validCheckIn.timestamp, pm25: 18, co2: null })
  })

  it('keeps indoor CO2 telemetry and its separate sensor health', () => {
    const result = parseCheckIn(
      { ...validCheckIn, sht3x_ok: false, scd30_ok: true, telemetry: { ...validCheckIn.telemetry, co2: 700 } },
      receivedAt,
    )
    expect(result.data?.heartbeat.scd30_ok).toBe(true)
    expect(result.data?.telemetry?.co2).toBe(700)
  })

  it('uses server time for health and leaves telemetry empty when RTC time is invalid', () => {
    const result = parseCheckIn({ ...validCheckIn, timestamp: null, rtc_ok: false, telemetry: null }, receivedAt)
    expect(result.data?.heartbeat.timestamp).toBe(receivedAt)
    expect(result.data?.telemetry).toBeNull()
  })

  it('rejects a missing telemetry payload and malformed health', () => {
    expect(parseCheckIn({ ...validCheckIn, telemetry: undefined }, receivedAt).error).toBe('invalid_telemetry')
    expect(parseCheckIn({ ...validCheckIn, rssi: -127 }, receivedAt).error).toBe('invalid_heartbeat')
    expect(parseCheckIn({ ...validCheckIn, sd_ok: 'true' }, receivedAt).error).toBe('invalid_heartbeat')
    expect(parseCheckIn({ ...validCheckIn, timestamp: null }, receivedAt).error).toBe(
      'invalid_telemetry_without_timestamp',
    )
  })
})
