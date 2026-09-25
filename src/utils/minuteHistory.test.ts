import { describe, expect, it } from 'vitest'
import { CsvMinuteAggregator, csvTimestamp } from '../../supabase/functions/_shared/csv-minute-history'
import { closedSyncWindow, istDayStart, minuteTimeline } from './minuteHistory'

const header = 'Date,Time,MC1.0,MC2.5,MC10.0,Temp_C,Humidity_RH_percent\r\n'
const start = istDayStart('2026-09-25')
describe('twice-daily CSV history', () => {
  it('uses midnight and noon IST, independent of browser timezone', () => {
    expect(closedSyncWindow(start + 12 * 3600000 - 1)).toBe(start)
    expect(closedSyncWindow(start + 12 * 3600000)).toBe(start + 12 * 3600000)
    expect(closedSyncWindow(start + 86400000)).toBe(start + 86400000)
    expect(csvTimestamp('25-09-2026', '00:00:00')).toBe(start)
    expect(csvTimestamp('31-02-2026', '00:00:00')).toBeNull()
    expect(csvTimestamp('25-09-2026', '24:00:00')).toBeNull()
  })
  it('averages valid samples, preserves missing values and excludes the cutoff', () => {
    const parser = new CsvMinuteAggregator(start, start + 60000, false)
    const csv =
      header +
      '25-09-2026,00:00:00,10,20,nan,25,50\r\n' +
      '25-09-2026,00:00:02,20,nan,nan,27,110\r\n' +
      '25-09-2026,00:01:00,999,999,999,30,50\r\n'
    for (let i = 0; i < csv.length; i += 7) parser.push(csv.slice(i, i + 7))
    expect(parser.finish()).toEqual([
      {
        timestamp: new Date(start).toISOString(),
        pm1: 15,
        pm25: 20,
        pm10: null,
        temperature: 26,
        rh: 50,
        co2: null,
        sample_count: 2,
        valid_counts: [2, 1, 0, 2, 1, 0],
      },
    ])
  })
  it('supports indoor headers and does not double-count repeated RTC seconds', () => {
    const parser = new CsvMinuteAggregator(start, start + 60000, true)
    parser.push(
      'Date,Time,MC1.0,MC2.5,MC10.0,Temp,Humidity,CO2\n' +
        '25-09-2026,00:00:00,10,20,30,25,50,600\n' +
        '25-09-2026,00:00:00,10,20,30,25,50,900\n' +
        '25-09-2026,00:00:02,10,20,30,25,50,800\n',
    )
    expect(parser.finish()[0].co2).toBe(700)
    expect(parser.duplicateRows).toBe(1)
  })
  it('skips malformed rows and incomplete snapshots; rejects recovery files', () => {
    const parser = new CsvMinuteAggregator(start, start + 60000, false)
    parser.push(header + 'bad,row\n25-09-2026,00:00:00,10,20,30,25,50')
    expect(parser.finish()).toEqual([])
    expect(parser.skippedRows).toBe(2)
    expect(() => new CsvMinuteAggregator(start, start + 60000, false).push('Record,UptimeMs,Date,Time\n')).toThrow(
      'verified',
    )
    expect(() => new CsvMinuteAggregator(start, start + 60000, true).push(header)).toThrow('sensor columns')
  })
  it('shows null gaps without manufacturing data and caps today at the sync boundary', () => {
    const timeline = minuteTimeline([], '2026-09-25', start + 15 * 3600000)
    expect(timeline).toHaveLength(720)
    expect(timeline.every((row) => row.pm1 === null && row.co2 === null)).toBe(true)
    expect(minuteTimeline([], '2026-09-25', start + 11 * 3600000)).toEqual([])
    expect(minuteTimeline([], '2026-09-24', start)).toHaveLength(1440)
  })
})
