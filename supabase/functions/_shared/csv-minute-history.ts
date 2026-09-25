export interface CsvMinute {
  timestamp: string
  pm1: number | null
  pm25: number | null
  pm10: number | null
  temperature: number | null
  rh: number | null
  co2: number | null
  sample_count: number
  valid_counts: number[]
}
const bounds = [
  [0, 10000],
  [0, 10000],
  [0, 10000],
  [-80, 100],
  [0, 100],
  [0.001, 1000000],
] as const
const aliases = [['MC1.0'], ['MC2.5'], ['MC10.0'], ['Temp_C', 'Temp'], ['Humidity_RH_percent', 'Humidity'], ['CO2']]
const istOffset = 19800000

/** CSV dates are DD-MM-YYYY and DS3231 clock values are IST, never browser local time. */
export function csvTimestamp(date: string, time: string): number | null {
  const d = /^(\d{2})-(\d{2})-(\d{4})$/.exec(date)
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time)
  if (!d || !t) return null
  const [day, month, year] = d.slice(1).map(Number)
  const [hour, minute, second] = t.slice(1).map(Number)
  if (year < 2020 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null
  const local = Date.UTC(year, month - 1, day, hour, minute, second)
  if (new Date(local).getUTCDate() !== day) return null
  return local - istOffset
}

/** Streaming parser for the numeric weekly CSV format emitted by both logger types. */
export class CsvMinuteAggregator {
  private remainder = ''
  private header: string[] | null = null
  private columns: number[] = []
  private dateIndex = -1
  private timeIndex = -1
  private buckets = new Map<number, { sums: number[]; counts: number[]; rows: number; seen: Set<number> }>()
  skippedRows = 0
  duplicateRows = 0
  parsedRows = 0

  constructor(
    private from: number,
    private until: number,
    private co2Enabled: boolean,
  ) {
    if (!Number.isFinite(from) || !Number.isFinite(until) || until < from || until - from > 8 * 86400000)
      throw new Error('Invalid CSV time window')
  }

  push(text: string) {
    this.remainder += text
    let start = 0
    let end: number
    while ((end = this.remainder.indexOf('\n', start)) !== -1) {
      this.line(this.remainder.slice(start, end).replace(/\r$/, ''))
      start = end + 1
    }
    this.remainder = this.remainder.slice(start)
    if (this.remainder.length > 4096) throw new Error('CSV row exceeds the logger format limit')
  }

  private line(line: string) {
    if (!line.trim()) return
    if (line.length > 4096) throw new Error('CSV row exceeds the logger format limit')
    const cells = line
      .replace(/^\uFEFF/, '')
      .split(',')
      .map((v) => v.trim())
    if (!this.header) {
      if (cells.includes('Record') || !cells.includes('Date') || !cells.includes('Time'))
        throw new Error('Expected a weekly CSV with verified Date and Time columns')
      this.header = cells
      this.dateIndex = cells.indexOf('Date')
      this.timeIndex = cells.indexOf('Time')
      this.columns = aliases.map((names) => cells.findIndex((c) => names.includes(c)))
      if (this.columns.slice(0, 5).some((i) => i < 0) || (this.co2Enabled && this.columns[5] < 0))
        throw new Error('CSV sensor columns do not match this logger')
      return
    }
    if (cells.length !== this.header.length) {
      this.skippedRows++
      return
    }
    const ts = csvTimestamp(cells[this.dateIndex], cells[this.timeIndex])
    if (ts === null) {
      this.skippedRows++
      return
    }
    if (ts < this.from || ts >= this.until) return
    const minute = Math.floor(ts / 60000) * 60000
    const second = Math.floor(ts / 1000) % 60
    let bucket = this.buckets.get(minute)
    if (!bucket) {
      bucket = { sums: Array(6).fill(0), counts: Array(6).fill(0), rows: 0, seen: new Set() }
      this.buckets.set(minute, bucket)
    }
    // A repeated RTC second after restart/clock correction must not double-weight a row.
    if (bucket.seen.has(second)) {
      this.duplicateRows++
      return
    }
    bucket.seen.add(second)
    bucket.rows++
    this.parsedRows++
    for (let i = 0; i < 6; i++) {
      if (i === 5 && !this.co2Enabled) continue
      const raw = this.columns[i] < 0 ? '' : cells[this.columns[i]]
      if (!raw || /^(nan|null|inf|-inf)$/i.test(raw)) continue
      const value = Number(raw)
      if (Number.isFinite(value) && value >= bounds[i][0] && value <= bounds[i][1]) {
        bucket.sums[i] += value
        bucket.counts[i]++
      }
    }
  }

  finish(): CsvMinute[] {
    if (!this.header) throw new Error('CSV header is missing')
    // The firmware freezes a byte snapshot; a partial last line is not a complete sample.
    if (this.remainder.trim()) this.skippedRows++
    this.remainder = ''
    return [...this.buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([time, b]) => {
        const values = b.sums.map((sum, i) => (b.counts[i] ? sum / b.counts[i] : null))
        return {
          timestamp: new Date(time).toISOString(),
          pm1: values[0],
          pm25: values[1],
          pm10: values[2],
          temperature: values[3],
          rh: values[4],
          co2: values[5],
          sample_count: b.rows,
          valid_counts: b.counts,
        }
      })
  }
}
