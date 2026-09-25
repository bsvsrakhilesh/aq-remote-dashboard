import type { Reading } from '../types'

export interface MinuteReading extends Reading {
  sampleCount: number
  validCounts: number[]
}
export const istDate = (time = Date.now()) => new Date(time + 19800000).toISOString().slice(0, 10)
export const istDayStart = (date: string) => Date.parse(`${date}T00:00:00+05:30`)
export const closedSyncWindow = (now = Date.now()) => Math.floor((now + 19800000) / 43200000) * 43200000 - 19800000

// Explicit null minutes prevent the chart from drawing lines across missing CSV data.
export function minuteTimeline(rows: MinuteReading[], date: string, now = Date.now()): Reading[] {
  const start = istDayStart(date)
  const end = Math.min(start + 86400000, closedSyncWindow(now))
  const byTime = new Map(rows.map((row) => [Date.parse(row.timestamp), row]))
  const result: Reading[] = []
  for (let time = start; time < end; time += 60000) {
    result.push(
      byTime.get(time) ?? {
        timestamp: new Date(time).toISOString(),
        pm1: null,
        pm25: null,
        pm10: null,
        temperature: null,
        rh: null,
        co2: null,
      },
    )
  }
  return result
}
