import { closedSyncWindow, istDayStart } from './minuteHistory'

export const metrics = [
  { key: 'pm1', label: 'PM1', unit: 'µg/m³', color: '#0a86a5' },
  { key: 'pm25', label: 'PM2.5', unit: 'µg/m³', color: '#2571c6' },
  { key: 'pm10', label: 'PM10', unit: 'µg/m³', color: '#7657c8' },
  { key: 'temperature', label: 'Temperature', unit: '°C', color: '#d27c26' },
  { key: 'rh', label: 'Humidity', unit: '%', color: '#188c81' },
  { key: 'co2', label: 'CO₂', unit: 'ppm', color: '#53945e' },
] as const
export type Metric = (typeof metrics)[number]['key']
export type ResearchSource = 'minute' | 'snapshot'
export type ResearchTab = 'compare' | 'heatmap' | 'reports' | 'quality'
export type ReportGroup = 'daily' | 'weekly' | 'period'
export interface ResearchConfig {
  deviceIds: string[]
  metricKeys: Metric[]
  from: string
  until: string
  source: ResearchSource
  tab: ResearchTab
}
export type SeriesRow = Record<Metric, number | null> & {
  device_id: string
  timestamp: string
  points: number
  valid_counts: number[]
  min_values: (number | null)[]
  max_values: (number | null)[]
  sample_rows: number
  incomplete_points: number
}
export function researchWindow(config: Pick<ResearchConfig, 'from' | 'until' | 'source'>, now = Date.now()) {
  const from = istDayStart(config.from)
  const requestedUntil = istDayStart(config.until) + 86400000
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(requestedUntil) ||
    requestedUntil <= from ||
    requestedUntil - from > 31 * 86400000
  )
    throw new Error('Choose a valid date range of at most 31 days.')
  const until = Math.min(requestedUntil, config.source === 'minute' ? closedSyncWindow(now) : now)
  return {
    from,
    until: Math.max(from, until),
    expected: Math.max(0, Math.floor((until - from) / (config.source === 'minute' ? 60000 : 300000))),
  }
}
export function summarize(rows: SeriesRow[], key: Metric, expected: number) {
  const index = metrics.findIndex((metric) => metric.key === key)
  let sum = 0,
    valid = 0,
    points = 0,
    samples = 0,
    incomplete = 0
  const minima: number[] = [],
    maxima: number[] = []
  for (const row of rows) {
    const n = Number(row.valid_counts[index] ?? 0)
    if (row[key] !== null && n > 0) {
      sum += row[key]! * n
      valid += n
    }
    if (row.min_values[index] !== null) minima.push(row.min_values[index]!)
    if (row.max_values[index] !== null) maxima.push(row.max_values[index]!)
    points += Number(row.points)
    samples += Number(row.sample_rows)
    incomplete += Number(row.incomplete_points)
  }
  return {
    average: valid ? sum / valid : null,
    min: minima.length ? Math.min(...minima) : null,
    max: maxima.length ? Math.max(...maxima) : null,
    valid,
    points,
    samples,
    incomplete,
    missing: Math.max(0, expected - valid),
    coverage: expected ? Math.min(100, (valid / expected) * 100) : null,
  }
}
export function reportPeriods(from: number, until: number, source: ResearchSource, group: ReportGroup) {
  if (until <= from) return []
  const offset = 19800000
  const cadence = source === 'minute' ? 60000 : 300000
  const weekday = new Date(from + offset).getUTCDay()
  let start = group === 'weekly' ? from - ((weekday + 6) % 7) * 86400000 : from
  const step = group === 'daily' ? 86400000 : group === 'weekly' ? 7 * 86400000 : until - from
  const periods: { label: string; from: number; until: number; expected: number }[] = []
  while (start < until) {
    const end = start + step
    const left = Math.max(from, start),
      right = Math.min(until, end)
    if (right > left) {
      const date = new Date(start + offset).toISOString().slice(0, 10)
      periods.push({
        label: group === 'weekly' ? `Week of ${date}` : group === 'daily' ? date : 'Selected period',
        from: left,
        until: right,
        expected: Math.floor((right - left) / cadence),
      })
    }
    start = end
  }
  return periods
}
export function comparisonRows(rows: SeriesRow[], devices: string[], key: Metric, from: number, until: number) {
  const values = new Map(rows.map((row) => [`${row.device_id}:${Date.parse(row.timestamp)}`, row[key]]))
  const result: { time: number; [device: string]: number | null }[] = []
  for (let time = from; time < until; time += 3600000) {
    const row: { time: number; [device: string]: number | null } = { time }
    for (const id of devices) row[id] = values.get(`${id}:${time}`) ?? null
    result.push(row)
  }
  return result
}
// An explainable review heuristic, not a sensor calibration or regulatory limit.
export function spikeCandidates(rows: SeriesRow[], key: Metric) {
  const sorted = [...rows].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const changes: { row: SeriesRow; delta: number }[] = []
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1],
      b = sorted[i]
    if (a[key] !== null && b[key] !== null && Date.parse(b.timestamp) - Date.parse(a.timestamp) === 3600000)
      changes.push({ row: b, delta: Math.abs(b[key]! - a[key]!) })
  }
  if (changes.length < 6) return []
  const magnitudes = changes.map((change) => change.delta).sort((a, b) => a - b)
  const median = magnitudes[Math.floor(magnitudes.length / 2)]
  const floor = key === 'co2' ? 200 : key === 'temperature' ? 3 : key === 'rh' ? 15 : 20
  return changes.filter((change) => change.delta > Math.max(floor, 6 * median))
}
export function csvCell(value: unknown) {
  const raw = value == null ? '' : String(value)
  const safe = /^[=+@\-\t\r]/.test(raw) && typeof value !== 'number' ? `'${raw}` : raw
  return `"${safe.replaceAll('"', '""')}"`
}
export const makeCsv = (rows: unknown[][]) => '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n')
export function downloadCsv(filename: string, rows: unknown[][]) {
  const url = URL.createObjectURL(new Blob([makeCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export function validSavedConfig(value: unknown): value is ResearchConfig {
  if (!value || typeof value !== 'object') return false
  const c = value as ResearchConfig
  if (
    !Array.isArray(c.deviceIds) ||
    c.deviceIds.length < 1 ||
    c.deviceIds.length > 20 ||
    !c.deviceIds.every((id) => typeof id === 'string') ||
    !Array.isArray(c.metricKeys) ||
    !c.metricKeys.length ||
    c.metricKeys.length > metrics.length ||
    !c.metricKeys.every((key) => metrics.some((m) => m.key === key)) ||
    !['minute', 'snapshot'].includes(c.source) ||
    !['compare', 'heatmap', 'reports', 'quality'].includes(c.tab)
  )
    return false
  try {
    researchWindow(c)
    return true
  } catch {
    return false
  }
}
