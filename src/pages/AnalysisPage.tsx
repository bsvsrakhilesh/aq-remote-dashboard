import { useEffect, useMemo, useState } from 'react'
import { BarChart3, Check, Download, Grid3X3, Printer, RefreshCw, Save, ShieldCheck, Trash2 } from 'lucide-react'
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts'
import { useDevices } from '../hooks/useData'
import { useResearch } from '../hooks/useResearch'
import { demoMode, readOnlyMode, supabase } from '../services/supabase'
import { istDate, istDayStart } from '../utils/minuteHistory'
import {
  comparisonRows,
  downloadCsv,
  metrics,
  reportPeriods,
  researchWindow,
  spikeCandidates,
  summarize,
  validSavedConfig,
  type ResearchConfig,
  type ReportGroup,
  type ResearchTab,
} from '../utils/research'

const colors = [
  '#2571c6',
  '#188c81',
  '#9859c4',
  '#d27c26',
  '#cb5274',
  '#598126',
  '#0a86a5',
  '#86705b',
  '#6672bd',
  '#b26d21',
]
const tabs = [
  { key: 'compare', label: 'Compare', icon: BarChart3 },
  { key: 'heatmap', label: 'Heatmap', icon: Grid3X3 },
  { key: 'reports', label: 'Reports', icon: Printer },
  { key: 'quality', label: 'Data quality', icon: ShieldCheck },
] as const
const initialConfig = (): ResearchConfig => ({
  deviceIds: [],
  metricKeys: ['pm25'],
  source: 'minute',
  tab: 'compare',
  from: istDate(Date.now() - 7 * 86400000),
  until: istDate(Date.now() - 86400000),
})
interface SavedView {
  id: string
  name: string
  config: ResearchConfig
}
const formatValue = (value: number | null) =>
  value === null ? '—' : value.toLocaleString('en-GB', { maximumFractionDigits: 1 })
const stamp = (value: number) =>
  new Date(value).toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

export function AnalysisPage() {
  const fleet = useDevices()
  const [config, setConfig] = useState<ResearchConfig>(initialConfig)
  const [saved, setSaved] = useState<SavedView[]>([])
  const [name, setName] = useState('')
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const [heatDay, setHeatDay] = useState(istDate(Date.now() - 86400000))
  const [reportGroup, setReportGroup] = useState<ReportGroup>('daily')
  const data = useResearch(config)
  const fleetIds = fleet.data.map((d) => d.id).join(',')
  useEffect(() => {
    if (fleetIds) setConfig((c) => (c.deviceIds.length ? c : { ...c, deviceIds: fleetIds.split(',').slice(0, 4) }))
  }, [fleetIds])
  useEffect(() => {
    let alive = true
    const load = async () => {
      if (demoMode || readOnlyMode) {
        const records: SavedView[] = JSON.parse(localStorage.getItem('aq-analysis-views') ?? '[]')
        return Array.isArray(records) ? records.filter((v) => validSavedConfig(v.config)) : []
      }
      const result = await supabase!.from('saved_analysis_views').select('id,name,config').order('created_at')
      if (result.error) throw result.error
      return (result.data as SavedView[]).filter((v) => validSavedConfig(v.config))
    }
    void load()
      .then((records) => {
        if (alive) setSaved(records)
      })
      .catch(() => {
        if (alive) setMessage('Saved views could not be loaded.')
      })
    return () => {
      alive = false
    }
  }, [])
  const selected = fleet.data.filter((d) => config.deviceIds.includes(d.id))
  const selectedMetrics = metrics.filter((m) => config.metricKeys.includes(m.key))
  const windowRange = useMemo(() => {
    try {
      return researchWindow(config)
    } catch {
      return { from: 0, until: 0, expected: 0 }
    }
  }, [config])
  const summaries = selected.flatMap((device) =>
    selectedMetrics
      .filter((m) => m.key !== 'co2' || device.co2Enabled)
      .map((metric) => ({
        device,
        metric,
        ...summarize(
          data.rows.filter((row) => row.device_id === device.id),
          metric.key,
          windowRange.expected,
        ),
      })),
  )
  const reportRows = reportPeriods(windowRange.from, windowRange.until, config.source, reportGroup).flatMap((period) =>
    selected.flatMap((device) =>
      selectedMetrics
        .filter((metric) => metric.key !== 'co2' || device.co2Enabled)
        .map((metric) => ({
          period: period.label,
          device,
          metric,
          ...summarize(
            data.rows.filter(
              (row) =>
                row.device_id === device.id &&
                Date.parse(row.timestamp) >= period.from &&
                Date.parse(row.timestamp) < period.until,
            ),
            metric.key,
            period.expected,
          ),
          expected: period.expected,
        })),
    ),
  )
  const covered = summaries.filter((s) => s.coverage !== null)
  const coverage = covered.length ? covered.reduce((n, s) => n + s.coverage!, 0) / covered.length : null
  const toggleDevice = (id: string) =>
    setConfig((c) => ({
      ...c,
      deviceIds: c.deviceIds.includes(id) ? c.deviceIds.filter((v) => v !== id) : [...c.deviceIds, id].slice(0, 20),
    }))
  const saveView = async () => {
    if (!name.trim() || saving || !validSavedConfig(config)) return
    setSaving(true)
    setMessage('')
    try {
      let record: SavedView
      if (demoMode || readOnlyMode) {
        record = { id: saved.find((v) => v.name === name.trim())?.id ?? crypto.randomUUID(), name: name.trim(), config }
        localStorage.setItem(
          'aq-analysis-views',
          JSON.stringify([...saved.filter((v) => v.name !== record.name), record]),
        )
      } else {
        const user = (await supabase!.auth.getUser()).data.user
        if (!user) throw new Error('Sign in again to save a view.')
        const result = await supabase!
          .from('saved_analysis_views')
          .upsert({ owner_id: user.id, name: name.trim(), config }, { onConflict: 'owner_id,name' })
          .select('id,name,config')
          .single()
        if (result.error) throw result.error
        record = result.data as SavedView
      }
      setSaved((previous) => [...previous.filter((v) => v.name !== record.name), record])
      setName('')
      setMessage('View saved.')
    } catch {
      setMessage('Could not save this view. Please retry.')
    } finally {
      setSaving(false)
    }
  }
  const deleteView = async (view: SavedView) => {
    try {
      if (!demoMode && !readOnlyMode) {
        const result = await supabase!.from('saved_analysis_views').delete().eq('id', view.id)
        if (result.error) throw result.error
      }
      const next = saved.filter((v) => v.id !== view.id)
      if (demoMode || readOnlyMode) localStorage.setItem('aq-analysis-views', JSON.stringify(next))
      setSaved(next)
    } catch {
      setMessage('Could not remove this saved view.')
    }
  }
  const exportData = () =>
    downloadCsv(
      `aq-${config.tab}-${config.from}-${config.until}.csv`,
      config.tab === 'reports'
        ? [
            [
              'Period',
              'Device',
              'Metric',
              'Unit',
              'From (IST)',
              'Through day (IST)',
              'Source',
              'Average',
              'Minimum',
              'Maximum',
              'Valid points',
              'Expected points',
              'Coverage %',
            ],
            ...reportRows.map((s) => [
              s.period,
              s.device.code,
              s.metric.label,
              s.metric.unit,
              config.from,
              config.until,
              config.source,
              s.average,
              s.min,
              s.max,
              s.valid,
              s.expected,
              s.coverage,
            ]),
          ]
        : [
            [
              'Device',
              'Hour start (UTC)',
              'Source',
              ...selectedMetrics.map((m) => `${m.label} (${m.unit})`),
              'Recorded points',
              'CSV sample rows',
            ],
            ...data.rows.map((row) => [
              fleet.data.find((d) => d.id === row.device_id)?.code,
              row.timestamp,
              config.source,
              ...selectedMetrics.map((m) => row[m.key]),
              row.points,
              config.source === 'minute' ? row.sample_rows : '',
            ]),
          ],
    )

  return (
    <div className="page research-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Research workspace</span>
          <h1>Understand your environment.</h1>
          <p>Compare your network, inspect data quality, and turn measurements into clear reports.</p>
        </div>
        <div className="research-actions">
          <button className="button secondary" onClick={data.reload} disabled={data.loading}>
            <RefreshCw size={16} />
            Refresh
          </button>
          <button className="button primary" disabled={!data.rows.length || data.loading} onClick={exportData}>
            <Download size={16} />
            Export CSV
          </button>
        </div>
      </section>
      <section className="panel research-controls" aria-label="Analysis filters">
        <div className="research-filter-row">
          <label>
            From · IST
            <input
              type="date"
              value={config.from}
              max={istDate()}
              onChange={(e) => setConfig((c) => ({ ...c, from: e.target.value }))}
            />
          </label>
          <label>
            Through · IST
            <input
              type="date"
              value={config.until}
              max={istDate()}
              onChange={(e) => setConfig((c) => ({ ...c, until: e.target.value }))}
            />
          </label>
          <label>
            Data source
            <select
              value={config.source}
              onChange={(e) => setConfig((c) => ({ ...c, source: e.target.value as ResearchConfig['source'] }))}
            >
              <option value="minute">One-minute CSV averages</option>
              <option value="snapshot">Five-minute live snapshots</option>
            </select>
          </label>
          <div className="research-presets" aria-label="Date presets">
            {[1, 7, 30].map((days) => (
              <button
                key={days}
                className="button secondary small"
                onClick={() =>
                  setConfig((c) => ({
                    ...c,
                    from: istDate(Date.now() - days * 86400000),
                    until: istDate(Date.now() - 86400000),
                  }))
                }
              >
                {days === 1 ? 'Yesterday' : `${days} days`}
              </button>
            ))}
          </div>
        </div>
        <fieldset className="research-chips">
          <legend>
            Loggers <span>{selected.length} selected</span>
          </legend>
          {fleet.data.map((d, i) => (
            <button
              type="button"
              key={d.id}
              aria-pressed={config.deviceIds.includes(d.id)}
              onClick={() => toggleDevice(d.id)}
            >
              <span className="research-dot" style={{ background: colors[i % colors.length] }} />
              {d.code}
              {config.deviceIds.includes(d.id) && <Check size={13} />}
            </button>
          ))}
        </fieldset>
        <fieldset className="research-chips">
          <legend>Measurements</legend>
          {metrics.map((m) => (
            <button
              type="button"
              key={m.key}
              aria-pressed={config.metricKeys.includes(m.key)}
              onClick={() =>
                setConfig((c) => ({
                  ...c,
                  metricKeys: c.metricKeys.includes(m.key)
                    ? c.metricKeys.length > 1
                      ? c.metricKeys.filter((k) => k !== m.key)
                      : c.metricKeys
                    : [...c.metricKeys, m.key],
                }))
              }
            >
              {m.label}
            </button>
          ))}
        </fieldset>
        <div className="saved-view-bar">
          <label>
            Save this view
            <input
              maxLength={80}
              placeholder="e.g. Indoor / outdoor · weekly"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button className="button secondary small" disabled={!name.trim() || saving} onClick={() => void saveView()}>
            <Save size={15} />
            Save
          </button>
          {saved.map((view) => (
            <span className="saved-view" key={view.id}>
              <button
                onClick={() => {
                  setConfig(view.config)
                  setMessage(`Loaded ${view.name}.`)
                }}
              >
                {view.name}
              </button>
              <button aria-label={`Delete saved view ${view.name}`} onClick={() => void deleteView(view)}>
                <Trash2 size={13} />
              </button>
            </span>
          ))}
        </div>
        {message && (
          <p role="status" className="research-feedback">
            {message}
          </p>
        )}
      </section>
      <div className="research-summary">
        <div>
          <span>Selected network</span>
          <strong>
            {selected.length} <small>loggers</small>
          </strong>
        </div>
        <div>
          <span>Measurement coverage</span>
          <strong>
            {formatValue(coverage)}
            <small>{coverage === null ? '' : '%'}</small>
          </strong>
        </div>
        <div>
          <span>Source resolution</span>
          <strong>{config.source === 'minute' ? '1 minute' : '5 minutes'}</strong>
        </div>
        <div>
          <span>Displayed comparison</span>
          <strong>
            Hourly <small>means</small>
          </strong>
        </div>
      </div>
      <nav className="research-tabs" aria-label="Analysis views">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            aria-pressed={config.tab === key}
            onClick={() => setConfig((c) => ({ ...c, tab: key as ResearchTab }))}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
      </nav>
      <div className="print-heading">
        <h1>AQ Observatory · research report</h1>
        <p>
          {config.from} — {config.until} IST ·{' '}
          {config.source === 'minute' ? 'One-minute CSV averages' : 'Five-minute snapshots'} · generated{' '}
          {stamp(Date.now())} IST
        </p>
      </div>
      <p className="research-source-note">
        {config.source === 'minute'
          ? 'CSV history updates at midnight and noon IST. Coverage excludes time after the latest scheduled cutoff. Means weight each valid minute equally.'
          : 'Live snapshots are sampled approximately every five minutes. Coverage is an estimate against that cadence.'}{' '}
        Missing periods are not filled. All times are IST.
      </p>
      {(data.error || fleet.error) && (
        <div className="error-banner" role="alert">
          {data.error ?? fleet.error}
          <button
            onClick={() => {
              fleet.reload()
              data.reload()
            }}
          >
            Retry
          </button>
        </div>
      )}
      {data.loading ? (
        <div className="empty" role="status">
          Preparing your analysis…
        </div>
      ) : !selected.length ? (
        <div className="empty">
          <h2>Select loggers to begin</h2>
          <p>Choose the devices you want to explore above.</p>
        </div>
      ) : !data.rows.length ? (
        <div className="empty">
          <BarChart3 size={30} />
          <h2>No measurements in this selection</h2>
          <p>Try an earlier date, another data source, or wait for the next CSV sync.</p>
        </div>
      ) : (
        <>
          {config.tab === 'compare' &&
            selectedMetrics.map((metric) => {
              const eligible = selected.filter((d) => metric.key !== 'co2' || d.co2Enabled)
              const chart = comparisonRows(
                data.rows,
                eligible.map((d) => d.id),
                metric.key,
                windowRange.from,
                windowRange.until,
              )
              return (
                <section className="panel research-chart" key={metric.key} aria-label={`${metric.label} comparison`}>
                  <div className="section-head">
                    <div>
                      <span className="eyebrow">Across your network</span>
                      <h2>
                        {metric.label} <small>{metric.unit}</small>
                      </h2>
                    </div>
                    <span className="research-tag">Hourly average</span>
                  </div>
                  {!eligible.length ? (
                    <p className="empty">None of the selected loggers measures {metric.label}.</p>
                  ) : (
                    <>
                      <div className="comparison-chart">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={chart} margin={{ top: 12, right: 15, bottom: 8, left: 0 }}>
                            <CartesianGrid stroke="var(--line)" vertical={false} />
                            <XAxis
                              dataKey="time"
                              type="number"
                              domain={['dataMin', 'dataMax']}
                              tickFormatter={(time) =>
                                new Date(time).toLocaleString('en-GB', {
                                  timeZone: 'Asia/Kolkata',
                                  day: '2-digit',
                                  month: 'short',
                                  hour: '2-digit',
                                })
                              }
                              minTickGap={65}
                              tick={{ fill: 'var(--muted)', fontSize: 11 }}
                            />
                            <YAxis tick={{ fill: 'var(--muted)', fontSize: 11 }} width={45} />
                            <Tooltip
                              labelFormatter={(value) => `${stamp(Number(value))} IST`}
                              contentStyle={{
                                background: 'var(--surface)',
                                border: '1px solid var(--line)',
                                borderRadius: 10,
                              }}
                              formatter={(value, name) => [formatValue(Number(value)) + ' ' + metric.unit, name]}
                            />
                            {eligible.map((device) => (
                              <Line
                                key={device.id}
                                name={device.code}
                                dataKey={device.id}
                                stroke={colors[fleet.data.findIndex((d) => d.id === device.id) % colors.length]}
                                strokeWidth={2}
                                dot={false}
                                connectNulls={false}
                                isAnimationActive={false}
                              />
                            ))}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                      <div className="comparison-legend">
                        {eligible.map((device) => (
                          <span key={device.id}>
                            <i
                              style={{
                                background: colors[fleet.data.findIndex((d) => d.id === device.id) % colors.length],
                              }}
                            />
                            {device.code}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              )
            })}
          {config.tab === 'heatmap' && (
            <section className="panel heatmap-panel">
              <div className="section-head">
                <div>
                  <span className="eyebrow">Patterns at a glance</span>
                  <h2>Fleet × hour</h2>
                  <p>Colour is relative to this selection, not an air-quality classification.</p>
                </div>
                <label>
                  Day · IST
                  <input
                    aria-label="Heatmap day"
                    type="date"
                    value={heatDay}
                    min={config.from}
                    max={config.until}
                    onChange={(e) => setHeatDay(e.target.value)}
                  />
                </label>
              </div>
              {selectedMetrics.map((metric) => {
                const day = istDayStart(heatDay)
                const rows = data.rows.filter(
                  (r) => Date.parse(r.timestamp) >= day && Date.parse(r.timestamp) < day + 86400000,
                )
                const values = rows.map((r) => r[metric.key]).filter((v): v is number => v !== null)
                const low = values.length ? Math.min(...values) : 0,
                  high = values.length ? Math.max(...values) : 0
                return (
                  <div className="heatmap-metric" key={metric.key}>
                    <h3>
                      {metric.label} <small>{metric.unit}</small>
                    </h3>
                    <div className="table-scroll">
                      <table className="heatmap-table">
                        <caption className="sr-only">
                          {metric.label} hourly averages on {heatDay} IST
                        </caption>
                        <thead>
                          <tr>
                            <th>Logger</th>
                            {Array.from({ length: 24 }, (_, i) => (
                              <th key={i}>{String(i).padStart(2, '0')}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {selected.map((device) => (
                            <tr key={device.id}>
                              <th scope="row">{device.code}</th>
                              {Array.from({ length: 24 }, (_, hour) => {
                                const value =
                                  rows.find(
                                    (r) =>
                                      r.device_id === device.id && Date.parse(r.timestamp) === day + hour * 3600000,
                                  )?.[metric.key] ?? null
                                const strength =
                                  value === null ? 0 : high === low ? 0.55 : 0.15 + (0.7 * (value - low)) / (high - low)
                                return (
                                  <td key={hour}>
                                    <span
                                      tabIndex={0}
                                      title={`${device.code}, ${hour}:00 IST: ${value === null ? 'No data' : formatValue(value) + ' ' + metric.unit}`}
                                      aria-label={`${device.code}, ${hour}:00: ${value === null ? 'No data' : formatValue(value) + ' ' + metric.unit}`}
                                      style={
                                        value === null
                                          ? undefined
                                          : {
                                              background: `color-mix(in srgb, var(--brand) ${strength * 100}%, var(--surface))`,
                                              color: strength > 0.5 ? 'var(--on-brand)' : 'var(--text)',
                                            }
                                      }
                                    >
                                      {value === null ? '—' : formatValue(value)}
                                    </span>
                                  </td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="heatmap-legend">
                      <span>{formatValue(values.length ? low : null)}</span>
                      <i />
                      <span>
                        {formatValue(values.length ? high : null)} {metric.unit}
                      </span>
                      <span>— No data</span>
                    </div>
                  </div>
                )
              })}
            </section>
          )}
          {config.tab === 'reports' && (
            <section className="panel report-panel">
              <div className="section-head">
                <div>
                  <span className="eyebrow">Ready to share</span>
                  <h2>
                    {reportGroup === 'daily'
                      ? 'Daily report'
                      : reportGroup === 'weekly'
                        ? 'Weekly report'
                        : 'Period summary'}
                  </h2>
                  <p>
                    {config.from} — {config.until} · IST
                  </p>
                </div>
                <button className="button secondary" onClick={() => window.print()}>
                  <Printer size={16} />
                  Print / save PDF
                </button>
              </div>
              <div className="research-presets report-group" aria-label="Report grouping">
                {(['daily', 'weekly', 'period'] as const).map((group) => (
                  <button
                    key={group}
                    className="button secondary small"
                    aria-pressed={reportGroup === group}
                    onClick={() => setReportGroup(group)}
                  >
                    {group === 'period' ? 'Whole period' : group === 'daily' ? 'By day' : 'By week'}
                  </button>
                ))}
              </div>
              <div className="table-scroll">
                <table className="research-table">
                  <thead>
                    <tr>
                      {[
                        'Period',
                        'Logger',
                        'Measurement',
                        'Average',
                        'Minimum',
                        'Maximum',
                        'Valid points',
                        'Coverage',
                      ].map((label) => (
                        <th key={label}>{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reportRows.slice(0, 200).map((s) => (
                      <tr key={s.period + s.device.id + s.metric.key}>
                        <td>{s.period}</td>
                        <th scope="row">{s.device.code}</th>
                        <td>
                          {s.metric.label}
                          <small>{s.metric.unit}</small>
                        </td>
                        <td>{formatValue(s.average)}</td>
                        <td>{formatValue(s.min)}</td>
                        <td>{formatValue(s.max)}</td>
                        <td>{s.valid.toLocaleString()}</td>
                        <td>
                          {formatValue(s.coverage)}
                          {s.coverage !== null && '%'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {reportRows.length > 200 && (
                <p className="research-source-note">
                  Showing the first 200 rows. Export CSV for all {reportRows.length.toLocaleString()} rows.
                </p>
              )}
              <p className="research-source-note">
                Minima and maxima are from the underlying{' '}
                {config.source === 'minute'
                  ? 'one-minute averages, not individual raw SD samples'
                  : 'five-minute snapshots'}
                . Means are weighted by valid source points. Coverage uses the selected time window and does not fill
                missing points.
              </p>
            </section>
          )}
          {config.tab === 'quality' && (
            <section className="quality-grid">
              {selected.map((device) => {
                const rows = data.rows.filter((r) => r.device_id === device.id)
                const qualityMetric = config.metricKeys.find((key) => key !== 'co2' || device.co2Enabled)
                const summary = qualityMetric ? summarize(rows, qualityMetric, windowRange.expected) : null
                const age = Math.max(0, (Date.now() - Date.parse(device.lastSeen)) / 60000)
                const spikes = selectedMetrics
                  .filter((metric) => metric.key !== 'co2' || device.co2Enabled)
                  .flatMap((metric) => spikeCandidates(rows, metric.key).map((s) => ({ ...s, metric })))
                return (
                  <article className="panel quality-card" key={device.id}>
                    <span className="eyebrow">{device.name}</span>
                    <h2>{device.code}</h2>
                    <dl>
                      <div>
                        <dt>Heartbeat age · now</dt>
                        <dd>
                          {formatValue(age)} min {age > 10 && <span className="research-warning">Stale</span>}
                        </dd>
                      </div>
                      <div>
                        <dt>
                          {qualityMetric
                            ? `Missing ${metrics.find((m) => m.key === qualityMetric)?.label} points`
                            : 'Selected measurements'}
                        </dt>
                        <dd>{summary ? summary.missing.toLocaleString() : 'Not installed'}</dd>
                      </div>
                      <div>
                        <dt>Minutes with invalid sensor samples</dt>
                        <dd>
                          {config.source === 'minute'
                            ? (summary?.incomplete.toLocaleString() ?? 'Not installed')
                            : 'CSV source only'}
                        </dd>
                      </div>
                      <div>
                        <dt>Unusual hourly changes</dt>
                        <dd>{spikes.length}</dd>
                      </div>
                    </dl>
                    {spikes.slice(0, 5).map((s, i) => (
                      <p className="quality-flag" key={i}>
                        {s.metric.label} changed by {formatValue(s.delta)} {s.metric.unit} near{' '}
                        {stamp(Date.parse(s.row.timestamp))} IST.
                      </p>
                    ))}
                    <p className="research-source-note">
                      Flags invite review; they do not remove readings. Unusual changes exceed six times the median
                      hourly change and a minimum magnitude. Fewer than seven adjacent hours is insufficient for this
                      check.
                    </p>
                  </article>
                )
              })}
            </section>
          )}
        </>
      )}
    </div>
  )
}
