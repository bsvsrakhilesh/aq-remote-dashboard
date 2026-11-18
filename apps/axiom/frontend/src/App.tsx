import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  CalendarDays,
  ChartNoAxesCombined,
  Database,
  Download,
  FlaskConical,
  LoaderCircle,
  RefreshCw,
  SlidersHorizontal,
  Sigma,
  Upload,
  LayoutDashboard,
  ShieldCheck,
  ArrowUpRight,
} from 'lucide-react'
import { getCatalog, getTimeSeries, type TimeSeriesQuery } from './api'
import { ImportDatasetDialog } from './components/ImportDatasetDialog'
import { WorkspaceState } from './components/WorkspaceState'
import { MonitorPicker } from './components/MonitorPicker'
import Overview, { type WorkspaceView } from './components/Overview'
import { csvCell, downloadFile, exportAnalysis } from './export'
import { CHART_COLORS } from './components/chartColors'
import type { Catalog, ImportedDataset, TimeSeriesResponse } from './types'

const TimeSeriesChart = lazy(() => import('./components/TimeSeriesChart'))
const CollocationWorkspace = lazy(() => import('./components/CollocationWorkspace'))
const StatisticsWorkspace = lazy(() => import('./components/StatisticsWorkspace').then(module => ({ default: module.StatisticsWorkspace })))

const PRESETS = [
  { label: '24H', hours: 24 },
  { label: '7D', hours: 24 * 7 },
  { label: '30D', hours: 24 * 30 },
  { label: 'All', hours: null },
]

const INTERVALS = [
  { value: 'raw', label: 'Raw' },
  { value: '1m', label: '1 min' },
  { value: '5m', label: '5 min' },
  { value: '15m', label: '15 min' },
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '1d', label: '1 day' },
]

function toLocalInput(value: Date | string) {
  const date = new Date(value)
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function apiDate(value: string) {
  return value.length === 16 ? `${value}:00` : value
}

function formatNumber(value: number | null | undefined, digits = 1) {
  if (value == null) return '—'
  return value.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function formatCompact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return value.toLocaleString()
}

function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [data, setData] = useState<TimeSeriesResponse | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [metric, setMetric] = useState('')
  const [interval, setInterval] = useState('5m')
  const [smoothing, setSmoothing] = useState(1)
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [activePreset, setActivePreset] = useState('7D')
  const [applied, setApplied] = useState<TimeSeriesQuery | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(() => new URLSearchParams(window.location.search).get('import') === '1')
  const [view, setView] = useState<WorkspaceView>(() => {
    const requested = new URLSearchParams(window.location.search).get('view')
    return requested === 'statistics' || requested === 'collocation' || requested === 'series' ? requested : 'overview'
  })
  const [visited, setVisited] = useState<Set<WorkspaceView>>(() => new Set([view]))
  useEffect(() => { setVisited(current => current.has(view) ? current : new Set([...current, view])) }, [view])
  const [statisticsDataset, setStatisticsDataset] = useState<string | undefined>()
  const [catalogAttempt, setCatalogAttempt] = useState(0)
  const [loadedQuery, setLoadedQuery] = useState<TimeSeriesQuery | null>(null)
  const navigate = (next: WorkspaceView) => {
    setView(next)
    const url = new URL(window.location.href)
    url.searchParams.set('view', next)
    window.history.pushState({}, '', url)
  }

  useEffect(() => {
    const onPopState = () => {
      const next = new URLSearchParams(window.location.search).get('view')
      setView(next === 'series' || next === 'statistics' || next === 'collocation' ? next : 'overview')
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  useEffect(() => {
    document.title = `${({ overview: 'Overview', series: 'Time series', statistics: 'Statistics', collocation: 'Collocation' })[view]} · Axiom`
  }, [view])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    getCatalog(controller.signal)
      .then((response) => {
        setCatalog(response)
        const preferred = response.monitors.find((dataset) => dataset.metrics.length > 0 && dataset.start && dataset.end)
        const initialMetric = preferred?.metrics[0] ?? response.metrics[0]?.id ?? ''
        if (!preferred || !response.range.end) {
          setLoading(false)
          return
        }
        const endDate = new Date(preferred.end!)
        const startDate = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000)
        const initialQuery: TimeSeriesQuery = {
          monitors: preferred ? [preferred.id] : [],
          metric: initialMetric,
          start: apiDate(toLocalInput(startDate)),
          end: apiDate(toLocalInput(endDate)),
          interval: '5m',
          smoothing: 1,
        }
        setSelected(initialQuery.monitors)
        setMetric(initialMetric)
        setStart(toLocalInput(startDate))
        setEnd(toLocalInput(endDate))
        setApplied(initialQuery)
      })
      .catch((reason: Error) => { if (!controller.signal.aborted) { setError(reason.message); setLoading(false) } })
    return () => controller.abort()
  }, [catalogAttempt])

  useEffect(() => {
    if (!applied || view !== 'series') return
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    getTimeSeries(applied, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setData(result); setLoadedQuery(applied) } })
      .catch((reason: Error) => {
        if (reason.name !== 'AbortError') setError(reason.message)
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [applied, view])

  const selectedMetric = catalog?.metrics.find((item) => item.id === (loadedQuery?.metric ?? metric))
  const invalidRange = !start || !end || new Date(start) >= new Date(end)
  const pendingChanges = loadedQuery && JSON.stringify({ monitors: selected, metric, start: apiDate(start), end: apiDate(end), interval, smoothing }) !== JSON.stringify(loadedQuery)

  const combined = useMemo(() => {
    const populated = data?.series.filter((series) => series.stats.points > 0) ?? []
    const latest = populated.map((series) => series.stats.latest).filter((value): value is number => value != null)
    const averages = populated.filter(series => series.stats.average != null)
    const count = averages.reduce((sum, series) => sum + series.stats.points, 0)
    const peaks = populated.map((series) => series.stats.maximum).filter((value): value is number => value != null)
    return {
      latest: latest.length ? latest.reduce((sum, value) => sum + value, 0) / latest.length : null,
      average: count ? averages.reduce((sum, series) => sum + series.stats.average! * series.stats.points, 0) / count : null,
      peak: peaks.length ? Math.max(...peaks) : null,
      samples: data?.total_points ?? 0,
    }
  }, [data])

  const applyFilters = () => {
    if (invalidRange || selected.length === 0) return
    setApplied({
      monitors: selected,
      metric,
      start: apiDate(start),
      end: apiDate(end),
      interval,
      smoothing,
    })
  }

  const setPreset = (label: string, hours: number | null) => {
    if (!catalog?.range.start || !catalog.range.end) return
    const members = catalog.monitors.filter(item => selected.includes(item.id) && item.start && item.end)
    const endDate = new Date(members.length ? Math.max(...members.map(item => new Date(item.end!).getTime())) : catalog.range.end)
    const startDate = hours == null
      ? new Date(members.length ? Math.min(...members.map(item => new Date(item.start!).getTime())) : catalog.range.start)
      : new Date(endDate.getTime() - hours * 60 * 60 * 1000)
    setStart(toLocalInput(startDate))
    setEnd(toLocalInput(endDate))
    setActivePreset(label)
  }

  const changeMetric = (nextMetric: string) => {
    setMetric(nextMetric)
    if (!catalog) return
    const available = new Set(
      catalog.monitors.filter((monitor) => monitor.metrics.includes(nextMetric)).map((monitor) => monitor.id),
    )
    const stillValid = selected.filter((id) => available.has(id))
    if (stillValid.length === 0) {
      const first = catalog.monitors.find((monitor) => available.has(monitor.id))
      setSelected(first ? [first.id] : [])
    } else {
      setSelected(stillValid)
    }
  }

  const exportCsv = () => {
    if (!data) return
    const rows = ['monitor,timestamp_source_clock,value,metric,unit']
    data.series.forEach((series) => {
      series.points.forEach((point) => {
        rows.push([series.monitor_name, new Date(point.timestamp).toISOString().replace('Z', ''), point.value, data.metric, data.unit].map(csvCell).join(','))
      })
    })
    downloadFile(`axiom-${loadedQuery?.metric}-${data.start.slice(0, 10)}.csv`, rows.join('\r\n'), 'text/csv;charset=utf-8')
  }

  const handleImported = async (dataset: ImportedDataset) => {
    const refreshed = await getCatalog()
    setCatalog(refreshed)
    setStatisticsDataset(dataset.id)
    navigate('statistics')
    const firstMetric = dataset.metrics[0]?.id
    if (!firstMetric || !dataset.start || !dataset.end) return
    const nextStart = toLocalInput(dataset.start)
    const nextEnd = toLocalInput(dataset.end)
    setSelected([dataset.id])
    setMetric(firstMetric)
    setStart(nextStart)
    setEnd(nextEnd)
    setInterval('5m')
    setSmoothing(1)
    setActivePreset('')
    setApplied({
      monitors: [dataset.id],
      metric: firstMetric,
      start: apiDate(nextStart),
      end: apiDate(nextEnd),
      interval: '5m',
      smoothing: 1,
    })
  }

  return (
    <div className="app-shell">
      <a href="#main-content" className="skip-link">Skip to content</a>
      <aside className="app-sidebar" aria-label="Workspace navigation">
        <a className="brand" href="?view=overview" onClick={event => { event.preventDefault(); navigate('overview') }}><span className="brand-mark"><Sigma size={22} /></span><span>Axiom<span className="brand-caption">RESEARCH WORKSPACE</span></span></a>
        <span className="sidebar-label">Workspace</span>
        <nav className="workspace-nav" aria-label="Workspace">
          {([{ id: 'overview', label: 'Overview', icon: LayoutDashboard }, { id: 'series', label: 'Time series', icon: ChartNoAxesCombined }, { id: 'statistics', label: 'Statistics', icon: Sigma }, { id: 'collocation', label: 'Collocation', icon: FlaskConical }] as const).map(item => <button key={item.id} aria-current={view === item.id ? 'page' : undefined} className={view === item.id ? 'active' : ''} onClick={() => navigate(item.id)}><item.icon size={18} />{item.label}{view === item.id && <span className="nav-indicator" />}</button>)}
        </nav>
        <div className="sidebar-note"><ShieldCheck size={20} /><strong>Evidence, with context.</strong><p>Explore your data with transparent methods and reproducible results.</p><a href="https://docs.scipy.org/doc/scipy/reference/stats.html" target="_blank" rel="noreferrer">Statistical reference <ArrowUpRight size={14} /></a></div>
        <div className="sidebar-bottom"><span className="workspace-avatar">A</span><div><strong>Research workspace</strong><small>Local data · your analysis</small></div></div>
      </aside>
      <header className="topbar">
        <div className="topbar-context">
          <span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{({ overview: 'Overview', series: 'Time series', statistics: 'Statistics', collocation: 'Collocation' })[view]}</strong>
        </div>
        <button className="topbar-import" type="button" onClick={() => setImportOpen(true)}>
          <Upload size={14} /> Import
        </button>
        <div className="topbar-status">
          <span className="status-dot" />
          {catalog ? `${catalog.monitors.length} datasets` : error ? 'Unavailable' : 'Connecting'}
        </div>
      </header>

      <main className="workspace" id="main-content" tabIndex={-1}>
        {error && !catalog && <div className="error-banner" role="alert"><strong>Couldn’t load your datasets.</strong><p>{error}</p><button className="button secondary" onClick={() => setCatalogAttempt(value => value + 1)}>Try again</button></div>}
        {view === 'overview' ? catalog ? <Overview catalog={catalog} onNavigate={navigate} onImport={() => setImportOpen(true)} onDataset={id => { setStatisticsDataset(id); navigate('statistics') }} /> : !error && <div className="analysis-loader" role="status"><LoaderCircle className="spin" /><span>Preparing your workspace…</span></div> : view === 'series' ? <>
        <section className="page-heading">
          <div>
            <div className="eyebrow"><Activity size={14} /> Analysis</div>
            <h1>Time series</h1>
            <p>Explore temporal patterns, compare datasets, and inspect every observation.</p>
          </div>
          <div className="heading-actions">
            <button className="button secondary" type="button" onClick={exportCsv} disabled={!data || loading}>
              <Download size={15} /> Export view
            </button>
            <button className="button secondary" type="button" disabled={!data || loading} onClick={() => exportAnalysis('axiom-timeseries.json', loadedQuery, data)}>Save analysis</button>
            <button className="button primary" type="button" onClick={() => setImportOpen(true)}>
              <Upload size={15} /> Import data
            </button>
          </div>
        </section>

        <section className="filter-card" aria-label="Chart controls">
          <div className="filter-row primary-filters">
            <div className="field monitor-field">
              <span>Dataset</span>
              {catalog
                ? <MonitorPicker monitors={catalog.monitors} selected={selected} metric={metric} onChange={setSelected} />
                : <div className="control skeleton-control" />}
            </div>
            <label className="field">
              <span>Metric</span>
              <select aria-label="Metric" className="control" value={metric} onChange={(event) => changeMetric(event.target.value)}>
                {catalog?.metrics.map((item) => (
                  <option key={item.id} value={item.id}>{item.label} · {item.unit}</option>
                ))}
              </select>
            </label>
            <label className="field date-field">
              <span>From</span>
              <div className="input-with-icon">
                <CalendarDays size={14} />
                <input aria-label="From" className="control" type="datetime-local" value={start} onChange={(event) => { setStart(event.target.value); setActivePreset('') }} />
              </div>
            </label>
            <label className="field date-field">
              <span>To</span>
              <div className="input-with-icon">
                <CalendarDays size={14} />
                <input aria-label="To" className="control" type="datetime-local" value={end} onChange={(event) => { setEnd(event.target.value); setActivePreset('') }} />
              </div>
            </label>
            <button className="button primary apply-button" type="button" onClick={applyFilters} disabled={!catalog || selected.length === 0 || invalidRange || loading}>
              <RefreshCw size={15} className={loading ? 'spin' : ''} /> Update chart
            </button>
          </div>

          <div className="filter-row secondary-filters">
            <div className="preset-group" aria-label="Date range presets">
              {PRESETS.map((preset) => (
                <button
                  type="button"
                  className={activePreset === preset.label ? 'active' : ''}
                  key={preset.label}
                  onClick={() => setPreset(preset.label, preset.hours)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <span className="small-divider" />
            <label className="inline-field">
              <span>Resolution</span>
              <select value={interval} onChange={(event) => setInterval(event.target.value)}>
                {INTERVALS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="inline-field">
              <span>Smoothing</span>
              <select value={smoothing} onChange={(event) => setSmoothing(Number(event.target.value))}>
                <option value={1}>Off</option>
                <option value={3}>3 points</option>
                <option value={5}>5 points</option>
                <option value={12}>12 points</option>
                <option value={24}>24 points</option>
              </select>
            </label>
            <div className="interaction-hint"><SlidersHorizontal size={13} /> Shift + scroll to zoom</div>
          </div>
        </section>

        {catalog && selected.length === 0 && <WorkspaceState title="Select a dataset with this metric">Choose another metric or import a dataset with a timestamp and numeric measurements.</WorkspaceState>}
        {invalidRange && start && end && <div className="error-banner" role="alert">Choose an end date after the start date.</div>}
        {pendingChanges && <div className="pending-banner" role="status"><SlidersHorizontal size={15} /> Controls have changed. Update the chart to apply them; results below describe the last completed analysis.</div>}

        {error && <div className="error-banner" role="alert">{error}</div>}

        <section className="stat-grid" aria-label="Summary statistics">
          <article className="stat-card">
            <span>Latest</span>
            <strong>{formatNumber(combined.latest, selectedMetric?.decimals)} <small>{selectedMetric?.unit}</small></strong>
            <p>{data && data.series.length > 1 ? `Mean across ${data.series.length} datasets` : 'Most recent valid observation'}</p>
          </article>
          <article className="stat-card">
            <span>Average</span>
            <strong>{formatNumber(combined.average, selectedMetric?.decimals)} <small>{selectedMetric?.unit}</small></strong>
            <p>Weighted by raw reading count</p>
          </article>
          <article className="stat-card">
            <span>Peak</span>
            <strong>{formatNumber(combined.peak, selectedMetric?.decimals)} <small>{selectedMetric?.unit}</small></strong>
            <p>Highest recorded value</p>
          </article>
          <article className="stat-card">
            <span>Readings analyzed</span>
            <strong>{data ? formatCompact(combined.samples) : '—'}</strong>
            <p>{data?.interval === 'auto' ? 'Chart detail optimized automatically' : `${data?.interval === 'raw' ? 'Raw' : data?.interval ?? '—'} chart resolution`}</p>
          </article>
        </section>

        <section className="chart-card">
          <div className="card-heading">
            <div>
              <h2>{data?.metric ?? selectedMetric?.label ?? 'Measurements'}</h2>
              <p>{data ? `${new Date(data.start).toLocaleDateString()} – ${new Date(data.end).toLocaleDateString()}` : 'Selected time range'} · Source clock time</p>
            </div>
            <div className="chart-meta">
              <span><span className="live-dot" /> {loading ? 'Loading data' : error ? 'Update failed' : data ? 'Data ready' : 'No data'}</span>
              <span>{data?.interval === 'auto' ? 'Auto resolution' : INTERVALS.find((item) => item.value === data?.interval)?.label}</span>
            </div>
          </div>
          {!loading && data?.series.every((series) => series.points.length === 0)
            ? <div className="empty-state"><Database size={24} /><strong>No observations in this range</strong><span>Try another date range or dataset.</span></div>
            : (
              <Suspense fallback={<div className="chart-loading" aria-label="Loading chart" />}>
                <TimeSeriesChart data={data} loading={loading} />
              </Suspense>
            )}
        </section>

        <section className="details-card">
          <div className="card-heading compact">
            <div>
              <h2>Series details</h2>
              <p>Statistics use raw readings before chart aggregation and smoothing.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Dataset</th>
                  <th>Latest</th>
                  <th>Average</th>
                  <th>Minimum</th>
                  <th>Maximum</th>
                  <th>95th percentile</th>
                  <th>Readings</th>
                </tr>
              </thead>
              <tbody>
                {data?.series.map((series, index) => (
                  <tr key={series.monitor_id}>
                    <td><span className="series-dot" style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />{series.monitor_name}</td>
                    <td>{formatNumber(series.stats.latest, selectedMetric?.decimals)}</td>
                    <td>{formatNumber(series.stats.average, selectedMetric?.decimals)}</td>
                    <td>{formatNumber(series.stats.minimum, selectedMetric?.decimals)}</td>
                    <td>{formatNumber(series.stats.maximum, selectedMetric?.decimals)}</td>
                    <td>{formatNumber(series.stats.p95, selectedMetric?.decimals)}</td>
                    <td>{series.stats.points.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        </> : null}
        {visited.has('collocation') && <div hidden={view !== 'collocation'}><Suspense fallback={<WorkspaceState title="Opening collocation" loading />}><CollocationWorkspace /></Suspense></div>}
        {visited.has('statistics') && <div hidden={view !== 'statistics'}>{catalog ? (
          <Suspense fallback={<div className="analysis-loader" role="status"><LoaderCircle className="spin" />Opening statistics…</div>}><StatisticsWorkspace key={statisticsDataset ?? 'statistics'} catalog={catalog} preferredDataset={statisticsDataset} /></Suspense>
        ) : !error && <div className="analysis-loader"><LoaderCircle className="spin" /><span>Loading datasets…</span></div>}</div>}
        <footer className="footer">
          <span><Database size={13} /> {catalog ? `${catalog.total_rows.toLocaleString()} rows indexed` : 'Indexing data'}</span>
          <span>{catalog?.invalid_rows ? `${catalog.invalid_rows.toLocaleString()} timestamp anomalies detected` : 'Schema validation active'}</span>
        </footer>
      </main>
      <ImportDatasetDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={handleImported}
      />
    </div>
  )
}

export default App
