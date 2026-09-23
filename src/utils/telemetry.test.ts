import { describe, expect, it } from 'vitest'
import { parseTelemetry } from '../../supabase/functions/_shared/telemetry'
import { devices, telemetryFor } from '../mocks/data'
import { collectTelemetryPages } from '../services/telemetry'

const sample = { timestamp: '2026-09-23T12:00:00Z', pm25: 18.4, pm10: 31.2, temperature: 26.4, rh: 58 }

describe('SCD30 telemetry contract', () => {
  it('accepts measured CO2 without changing the existing measurements', () => {
    expect(parseTelemetry({ ...sample, co2: 812.5 })).toEqual({ data: { ...sample, co2: 812.5 } })
  })
  it('keeps old firmware compatible and missing CO2 null', () => {
    expect(parseTelemetry(sample)).toEqual({ data: { ...sample, co2: null } })
    expect(parseTelemetry({ ...sample, co2: null })).toEqual({ data: { ...sample, co2: null } })
  })
  it.each([0, -1, 1000001, NaN, Infinity, -Infinity, '812', true, [], {}])('rejects invalid CO2 %j', (co2) => {
    expect(parseTelemetry({ ...sample, co2 })).toEqual({ error: 'invalid_co2' })
  })
  it('accepts unavailable primary sensors alongside a valid CO2 reading', () => {
    expect(parseTelemetry({ ...sample, pm25: null, pm10: null, temperature: null, rh: null, co2: 450 }).data?.co2).toBe(
      450,
    )
  })
  it.each([null, [], 'value', 15])('rejects malformed telemetry %j', (body) => {
    expect(parseTelemetry(body)).toEqual({ error: 'invalid_json' })
  })
  it('still requires a valid timestamp and original measurement fields', () => {
    expect(parseTelemetry({ ...sample, timestamp: 'bad' })).toEqual({ error: 'invalid_timestamp' })
    expect(parseTelemetry({ ...sample, timestamp: 123 })).toEqual({ error: 'invalid_timestamp' })
    expect(parseTelemetry({ ...sample, pm25: undefined })).toEqual({ error: 'invalid_pm25' })
  })
})

describe('isolated CO2 preview data', () => {
  it('includes CO2 gaps and leaves unsupported devices unpopulated', () => {
    const enabled = devices.find((device) => device.co2Enabled)!
    const disabled = devices.find((device) => !device.co2Enabled)!
    const readings = telemetryFor(enabled, '24h')
    expect(readings.some((reading) => reading.co2 === null)).toBe(true)
    expect(readings.some((reading) => typeof reading.co2 === 'number' && reading.co2 > 0)).toBe(true)
    expect(telemetryFor(disabled, '24h').every((reading) => reading.co2 === null)).toBe(true)
  })
})

describe('full telemetry range loading', () => {
  it('loads a month without silently truncating after the first 1000 measurements', async () => {
    const rows = Array.from({ length: 8640 }, (_, index) => ({ co2: 600 + index }))
    const calls: number[] = []
    const result = await collectTelemetryPages(async (from, to) => {
      calls.push(from)
      return rows.slice(from, to + 1)
    })
    expect(result).toEqual(rows)
    expect(calls).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000])
  })
  it('returns an empty history when no rows exist', async () => {
    expect(await collectTelemetryPages(async () => [])).toEqual([])
  })
  it('reports page failures instead of returning an incomplete series', async () => {
    await expect(
      collectTelemetryPages(async (from) => {
        if (from === 0) return Array.from({ length: 1000 }, () => sample)
        throw new Error('Network unavailable')
      }),
    ).rejects.toThrow('Network unavailable')
  })
})
