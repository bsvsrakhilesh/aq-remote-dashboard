import { describe, expect, it } from 'vitest'
import {
  comparisonRows,
  csvCell,
  reportPeriods,
  researchWindow,
  spikeCandidates,
  summarize,
  validSavedConfig,
  type SeriesRow,
} from './research'
const row = (hour: number, value: number, count = 60): SeriesRow => ({
  device_id: 'a',
  timestamp: new Date(Date.UTC(2026, 8, 24, hour)).toISOString(),
  points: count,
  pm1: value,
  pm25: value,
  pm10: value,
  temperature: 25,
  rh: 50,
  co2: null,
  valid_counts: [count, count, count, count, count, 0],
  min_values: [value, value, value, 25, 50, null],
  max_values: [value, value, value, 25, 50, null],
  sample_rows: count * 30,
  incomplete_points: 0,
})
describe('research analysis', () => {
  it('weights summaries by valid source points, not hours', () => {
    expect(summarize([row(0, 10, 60), row(1, 40, 30)], 'pm25', 120)).toMatchObject({
      average: 20,
      valid: 90,
      coverage: 75,
      missing: 30,
      min: 10,
      max: 40,
    })
    expect(summarize([row(0, 10)], 'co2', 60).average).toBeNull()
  })
  it('keeps gaps explicit for every selected device', () => {
    const start = Date.parse(row(0, 10).timestamp)
    expect(comparisonRows([row(0, 10)], ['a', 'b'], 'pm1', start, start + 7200000)).toEqual([
      { time: start, a: 10, b: null },
      { time: start + 3600000, a: null, b: null },
    ])
  })
  it('limits dates and excludes time after the CSV cutoff', () => {
    expect(
      researchWindow(
        { from: '2026-09-25', until: '2026-09-25', source: 'minute' },
        Date.parse('2026-09-25T17:00:00+05:30'),
      ).expected,
    ).toBe(720)
    expect(() => researchWindow({ from: '2026-01-01', until: '2026-12-31', source: 'minute' })).toThrow('31 days')
    expect(
      validSavedConfig({
        deviceIds: [],
        metricKeys: ['invented'],
        from: '2026-09-25',
        until: '2026-09-25',
        source: 'minute',
        tab: 'compare',
      }),
    ).toBe(false)
  })
  it('escapes CSV cells and spreadsheet formulas', () => {
    expect(csvCell('=cmd()')).toBe('"\'=cmd()"')
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
    expect(csvCell(-3)).toBe('"-3"')
  })
  it('flags unusual adjacent hourly changes without crossing gaps', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, i === 8 ? 150 : 10 + i))
    expect(spikeCandidates(rows, 'pm25')).toHaveLength(2)
    expect(spikeCandidates(rows.slice(0, 4), 'pm25')).toEqual([])
  })
  it('makes daily and Monday-based weekly reports in IST with partial-period coverage', () => {
    const from = Date.parse('2026-09-25T00:00:00+05:30')
    const until = from + 3 * 86400000
    expect(reportPeriods(from, until, 'minute', 'daily').map((period) => period.expected)).toEqual([1440, 1440, 1440])
    expect(reportPeriods(from, until, 'minute', 'weekly')).toEqual([
      {
        label: 'Week of 2026-09-21',
        from,
        until,
        expected: 4320,
      },
    ])
    expect(reportPeriods(from, from + 12 * 3600000, 'snapshot', 'period')[0].expected).toBe(144)
  })
})
