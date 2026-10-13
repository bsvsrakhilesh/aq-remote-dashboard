import { describe, expect, it } from 'vitest'
import { mergeTelemetryRows } from './telemetry'

describe('mergeTelemetryRows', () => {
  it('replaces overlapping readings, keeps chronological order, and trims the expired window', () => {
    const cached = [
      { timestamp: '2026-10-12T09:45:00Z', pm25: 10 },
      { timestamp: '2026-10-12T10:00:00Z', pm25: 20 },
    ]
    const fresh = [
      { timestamp: '2026-10-12T10:15:00+00:00', pm25: 30 },
      { timestamp: '2026-10-12T10:00:00+00:00', pm25: 25 },
    ]

    expect(mergeTelemetryRows(cached, fresh, Date.parse('2026-10-12T10:00:00Z'))).toEqual([
      { timestamp: '2026-10-12T10:00:00+00:00', pm25: 25 },
      { timestamp: '2026-10-12T10:15:00+00:00', pm25: 30 },
    ])
  })
})
