import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  BarChart3,
  BookOpen,
  CheckCircle2,
  FlaskConical,
  Grid3X3,
  Info,
  LoaderCircle,
  Sigma,
  Download,
} from 'lucide-react'
import { exportAnalysis } from '../export'
import { WorkspaceState } from './WorkspaceState'
import { QuantilePlot } from './QuantilePlot'
import {
  getCorrelation,
  getDistribution,
  getStatisticalProfile,
  getTimeDiagnostics,
  runStatisticalTest,
} from '../api'
import type {
  Catalog,
  CorrelationResult,
  DistributionResult,
  StatisticalProfile,
  StatisticalTestResult,
  StatColumnProfile,
  TimeDiagnosticsResult,
} from '../types'

interface Props {
  catalog: Catalog
  preferredDataset?: string
}

type Tab = 'overview' | 'distribution' | 'relationships' | 'time' | 'tests'
type Mode = 'guided' | 'expert'

const TESTS = [
  { value: 'one_sample_t', label: 'One-sample t-test', use: 'Compare one mean with a target', kind: 'one' },
  { value: 'independent_t', label: 'Welch’s independent t-test', use: 'Compare two independent groups', kind: 'group' },
  { value: 'paired_t', label: 'Paired t-test', use: 'Compare two paired measurements', kind: 'pair' },
  { value: 'mann_whitney', label: 'Mann–Whitney U', use: 'Non-parametric two-group comparison', kind: 'group' },
  { value: 'wilcoxon', label: 'Wilcoxon signed-rank', use: 'Non-parametric paired comparison', kind: 'pair' },
  { value: 'anova', label: 'One-way ANOVA', use: 'Compare means across 2+ groups', kind: 'group' },
  { value: 'kruskal', label: 'Kruskal–Wallis', use: 'Non-parametric comparison across groups', kind: 'group' },
  { value: 'chi_square', label: 'Chi-square independence', use: 'Test association between categories', kind: 'categorical' },
  { value: 'linear_regression', label: 'Simple linear regression', use: 'Model a linear numeric relationship', kind: 'pair' },
] as const

function format(value: unknown, digits = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value !== 0 && Math.abs(value) < 0.001) return value.toExponential(2)
  return value.toLocaleString(undefined, { maximumFractionDigits: digits })
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(value / 1024)} KB`
}

function correlationColor(value: number | null) {
  if (value == null) return 'transparent'
  const opacity = 0.08 + Math.abs(value) * 0.7
  return value >= 0 ? `rgba(23, 107, 82, ${opacity})` : `rgba(183, 70, 85, ${opacity})`
}

function summaryForColumn(column: StatColumnProfile) {
  if (column.type === 'numeric') return `μ ${format(column.mean)} · median ${format(column.median)} · σ ${format(column.std)}`
  if (column.type === 'datetime') return `${String(column.minimum).slice(0, 10)} → ${String(column.maximum).slice(0, 10)}`
  return column.top_values?.[0] ? `${column.top_values[0].value} · ${column.top_values[0].percent}%` : 'No values'
}

export function StatisticsWorkspace({ catalog, preferredDataset }: Props) {
  const [datasetId, setDatasetId] = useState(preferredDataset ?? catalog.monitors[0]?.id ?? '')
  const [profile, setProfile] = useState<StatisticalProfile | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [mode, setMode] = useState<Mode>('guided')
  const [profileLoading, setProfileLoading] = useState(false)
  const [distributionLoading, setDistributionLoading] = useState(false)
  const [correlationLoading, setCorrelationLoading] = useState(false)
  const [timeLoading, setTimeLoading] = useState(false)
  const loading = profileLoading || (tab === 'distribution' && distributionLoading) || (tab === 'relationships' && correlationLoading) || (tab === 'time' && timeLoading)
  const [error, setError] = useState<string | null>(null)

  const [numericColumn, setNumericColumn] = useState('')
  const [bins, setBins] = useState(30)
  const [distribution, setDistribution] = useState<DistributionResult | null>(null)
  const [correlationMethod, setCorrelationMethod] = useState('pearson')
  const [correlationColumns, setCorrelationColumns] = useState<string[]>([])
  const [correlation, setCorrelation] = useState<CorrelationResult | null>(null)
  const [timestampColumn, setTimestampColumn] = useState('')
  const [timeDiagnostics, setTimeDiagnostics] = useState<TimeDiagnosticsResult | null>(null)

  const [testName, setTestName] = useState('independent_t')
  const [columnA, setColumnA] = useState('')
  const [columnB, setColumnB] = useState('')
  const [groupColumn, setGroupColumn] = useState('')
  const [groupA, setGroupA] = useState('')
  const [groupB, setGroupB] = useState('')
  const [targetMean, setTargetMean] = useState(0)
  const [alpha, setAlpha] = useState(0.05)
  const [testResult, setTestResult] = useState<StatisticalTestResult | null>(null)
  const [testLoading, setTestLoading] = useState(false)
  const testController = useRef<AbortController | null>(null)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    testController.current?.abort()
    setTestLoading(false)
    setTestResult(null)
    return () => testController.current?.abort()
  }, [datasetId, testName, columnA, columnB, groupColumn, groupA, groupB, targetMean, alpha])

  useEffect(() => {
    const options = profile?.column_profiles.find(column => column.name === groupColumn)?.top_values?.filter(item => item.value !== '(missing)') ?? []
    setGroupA(options[0]?.value ?? '')
    setGroupB(options[1]?.value ?? '')
  }, [profile, groupColumn])

  useEffect(() => {
    if (!datasetId) return
    const controller = new AbortController()
    setProfileLoading(true)
    setError(null)
    setProfile(null)
    getStatisticalProfile(datasetId, controller.signal)
      .then((result) => {
        setProfile(result)
        const numeric = result.column_profiles.filter((column) => column.type === 'numeric').map((column) => column.name)
        const categorical = result.column_profiles.filter((column) => ['categorical', 'boolean', 'text'].includes(column.type)).map((column) => column.name)
        setNumericColumn(numeric[0] ?? '')
        setColumnA(numeric[0] ?? '')
        setColumnB(numeric.length ? numeric[1] ?? '' : categorical[1] ?? '')
        setTestName(numeric.length ? categorical.length ? 'independent_t' : 'one_sample_t' : 'chi_square')
        setGroupColumn(categorical[0] ?? '')
        setTimestampColumn(result.column_profiles.find((column) => column.type === 'datetime')?.name ?? '')
        setCorrelationColumns(numeric.slice(0, 8))
        setDistribution(null)
        setCorrelation(null)
        setTestResult(null)
      })
      .catch((reason: Error) => {
        if (reason.name !== 'AbortError') setError(reason.message)
      })
      .finally(() => { if (!controller.signal.aborted) setProfileLoading(false) })
    return () => controller.abort()
  }, [datasetId, retry])

  const numericColumns = useMemo(
    () => profile?.column_profiles.filter((column) => column.type === 'numeric') ?? [],
    [profile],
  )
  const categoricalColumns = useMemo(
    () => profile?.column_profiles.filter((column) => ['categorical', 'boolean', 'text'].includes(column.type)) ?? [],
    [profile],
  )

  useEffect(() => {
    setDistributionLoading(false)
    setDistribution(null)
    if (tab !== 'distribution' || profile?.dataset.id !== datasetId || !numericColumn) return
    const controller = new AbortController()
    setDistributionLoading(true)
    setError(null)
    const timer = window.setTimeout(() => { getDistribution(datasetId, numericColumn, bins, controller.signal)
      .then(setDistribution)
      .catch((reason: Error) => { if (reason.name !== 'AbortError') setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setDistributionLoading(false) }) }, 180)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [tab, datasetId, numericColumn, bins, profile])

  useEffect(() => {
    setCorrelationLoading(false)
    setCorrelation(null)
    if (tab !== 'relationships' || profile?.dataset.id !== datasetId || correlationColumns.length < 2) return
    const controller = new AbortController()
    setCorrelationLoading(true)
    setError(null)
    getCorrelation(datasetId, correlationColumns, correlationMethod, controller.signal)
      .then(setCorrelation)
      .catch((reason: Error) => { if (reason.name !== 'AbortError') setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setCorrelationLoading(false) })
    return () => controller.abort()
  }, [tab, datasetId, correlationColumns, correlationMethod, profile])

  useEffect(() => {
    setTimeLoading(false)
    setTimeDiagnostics(null)
    if (tab !== 'time' || profile?.dataset.id !== datasetId || !timestampColumn || !numericColumn) return
    const controller = new AbortController()
    setTimeLoading(true)
    setError(null)
    getTimeDiagnostics(datasetId, timestampColumn, numericColumn, 40, controller.signal)
      .then(setTimeDiagnostics)
      .catch((reason: Error) => { if (reason.name !== 'AbortError') setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setTimeLoading(false) })
    return () => controller.abort()
  }, [tab, datasetId, timestampColumn, numericColumn, profile])

  const insights = useMemo(() => {
    if (!profile) return []
    const result: string[] = []
    if (profile.completeness === 100) result.push('No missing values were detected.')
    else result.push(`${format(100 - profile.completeness, 1)}% of cells are missing; review affected columns before modeling.`)
    if (profile.duplicate_rows) result.push(`${profile.duplicate_rows.toLocaleString()} duplicate rows may bias summaries or tests.`)
    if (profile.invalid_cells) result.push(`${profile.invalid_cells.toLocaleString()} non-missing values could not be used as their inferred type. Review invalid cells before interpreting results.`)
    const skewed = numericColumns.filter((column) => Math.abs(column.skewness ?? 0) > 1)
    if (skewed.length) result.push(`${skewed.slice(0, 3).map((column) => column.name).join(', ')} ${skewed.length === 1 ? 'is' : 'are'} strongly skewed; consider medians or non-parametric tests.`)
    if (!result.length) result.push('The dataset is ready for exploratory analysis.')
    return result
  }, [profile, numericColumns])

  const runTest = async () => {
    testController.current?.abort()
    const controller = new AbortController()
    testController.current = controller
    const definition = TESTS.find((test) => test.value === testName)!
    let columns: string[] = [columnA]
    let selectedGroup: string | null = null
    if (definition.kind === 'pair') columns = [columnA, columnB]
    if (definition.kind === 'group') selectedGroup = groupColumn
    if (definition.kind === 'categorical') columns = [groupColumn, columnB]
    setTestLoading(true)
    setError(null)
    setTestResult(null)
    try {
      const result = await runStatisticalTest({
        dataset_id: datasetId,
        test: testName,
        columns,
        group_column: selectedGroup,
        groups: ['independent_t', 'mann_whitney'].includes(testName) && groupA && groupB ? [groupA, groupB] : null,
        hypothesized_mean: targetMean,
        alpha,
      }, controller.signal)
      if (!controller.signal.aborted) setTestResult(result)
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'The test could not be completed')
    } finally {
      if (!controller.signal.aborted) setTestLoading(false)
    }
  }

  const selectedNumericProfile = numericColumns.find((column) => column.name === numericColumn)
  const histogramMax = Math.max(...(distribution?.histogram.counts ?? [1]))
  const currentTest = TESTS.find((test) => test.value === testName)!

  return (
    <>
      <section className="page-heading statistics-heading">
        <div>
          <div className="eyebrow"><Sigma size={14} /> Statistical analysis</div>
          <h1>Statistics</h1>
          <p>Explore, validate, compare, and test any structured dataset.</p>
        </div>
        <div className="statistics-toolbar">
          <button className="button secondary" disabled={!profile || loading || testLoading} onClick={() => exportAnalysis('axiom-statistics.json', { dataset_id: datasetId, section: tab, column: numericColumn, bins, correlation_method: correlationMethod, correlation_columns: correlationColumns, timestamp: timestampColumn }, { profile, distribution, correlation, time_diagnostics: timeDiagnostics, test: testResult })}><Download size={14} /> Export analysis</button>
          <label className="dataset-select">
            <span>Dataset</span>
            <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
              {catalog.monitors.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}
            </select>
          </label>
          <div className="mode-switch" aria-label="Analysis experience">
            <button type="button" aria-pressed={mode === 'guided'} className={mode === 'guided' ? 'active' : ''} onClick={() => setMode('guided')}><BookOpen size={13} /> Guided</button>
            <button type="button" aria-pressed={mode === 'expert'} className={mode === 'expert' ? 'active' : ''} onClick={() => setMode('expert')}><FlaskConical size={13} /> Expert</button>
          </div>
        </div>
      </section>

      <nav className="analysis-tabs" aria-label="Statistical analysis sections">
        <button aria-pressed={tab === 'overview'} className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}><Grid3X3 size={14} /> Overview</button>
        <button aria-pressed={tab === 'distribution'} className={tab === 'distribution' ? 'active' : ''} onClick={() => setTab('distribution')}><BarChart3 size={14} /> Distributions</button>
        <button aria-pressed={tab === 'relationships'} className={tab === 'relationships' ? 'active' : ''} onClick={() => setTab('relationships')}><Sigma size={14} /> Relationships</button>
        <button aria-pressed={tab === 'time'} className={tab === 'time' ? 'active' : ''} onClick={() => setTab('time')}><BarChart3 size={14} /> Time diagnostics</button>
        <button aria-pressed={tab === 'tests'} className={tab === 'tests' ? 'active' : ''} onClick={() => setTab('tests')}><FlaskConical size={14} /> Statistical tests</button>
      </nav>

      {error && <div className="error-banner" role="alert"><AlertCircle size={14} /> {error} <button className="button secondary" onClick={() => setRetry(value => value + 1)}>Retry</button></div>}
      {!datasetId && <div className="library-empty"><Sigma size={28} /><h2>No datasets yet</h2><p>Use Import in the top bar to add your first dataset. A time column is optional.</p></div>}
      {profile && <details className="statistical-assumptions"><summary>Methods & interpretation</summary><p>Descriptive summaries use valid numeric observations. The mean confidence interval assumes independent observations; autocorrelated sensor readings can make this interval too narrow. Missing pairs are excluded from correlations and paired tests.</p><p>Correlation markers use Benjamini–Hochberg adjusted p-values across the unique pairs shown. This controls the false discovery rate under independent or suitable positive dependence assumptions. Normality tests use up to 5,000 observations with a fixed sampling seed. A non-significant result does not prove normality, equivalence, or no effect.</p><a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.false_discovery_control.html" target="_blank" rel="noreferrer">Multiple testing reference ↗</a> · <a href="https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.shapiro.html" target="_blank" rel="noreferrer">Normality reference ↗</a></details>}
      {loading && !profile ? <div className="analysis-loader"><LoaderCircle className="spin" /><span>Profiling every column…</span></div> : null}

      {profile && tab === 'overview' && (
        <>
          <section className="stat-grid profile-stats">
            <article className="stat-card"><span>Rows</span><strong>{profile.rows.toLocaleString()}</strong><p>{profile.columns} columns</p></article>
            <article className="stat-card"><span>Completeness</span><strong>{format(profile.completeness, 1)}<small>%</small></strong><p>{profile.missing_cells.toLocaleString()} missing cells</p></article>
            <article className="stat-card"><span>Duplicate rows</span><strong>{profile.duplicate_rows.toLocaleString()}</strong><p>{format(profile.duplicate_rows / Math.max(profile.rows, 1) * 100, 2)}% of the dataset</p></article>
            <article className="stat-card"><span>Memory footprint</span><strong>{formatBytes(profile.memory_bytes)}</strong><p>{profile.type_counts.numeric} numeric · {profile.type_counts.datetime} date/time</p></article>
          </section>

          {mode === 'guided' && (
            <section className="insight-panel">
              <div className="insight-heading"><span><Info size={15} /></span><div><strong>What to notice</strong><small>Automatic guidance—not a substitute for domain judgment.</small></div></div>
              <ul>{insights.map((insight) => <li key={insight}>{insight}</li>)}</ul>
            </section>
          )}

          <section className="details-card profile-table-card">
            <div className="card-heading compact"><div><h2>Column profile</h2><p>Types and descriptive summaries inferred from the complete dataset.</p></div></div>
            <div className="table-wrap">
              <table className="profile-table">
                <thead><tr><th>Column</th><th>Type</th><th>Valid</th><th>Missing</th><th>Invalid</th><th>Unique</th><th>Summary</th></tr></thead>
                <tbody>{profile.column_profiles.map((column) => (
                  <tr key={column.name}>
                    <td><strong>{column.name}</strong></td>
                    <td><span className={`type-badge ${column.type}`}>{column.type}</span></td>
                    <td>{column.count.toLocaleString()}</td>
                    <td>{format(column.missing_percent, 1)}%</td>
                    <td>{column.invalid?.toLocaleString() ?? 0}</td><td>{column.unique.toLocaleString()}</td>
                    <td className="summary-cell">{summaryForColumn(column)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {profile && tab === 'distribution' && (
        <section className="analysis-grid distribution-layout">
          <aside className="analysis-controls-card">
            <h2>Distribution setup</h2>
            <p>Inspect shape, spread, outliers, and normality.</p>
            <label className="field"><span>Numeric column</span><select className="control" value={numericColumn} onChange={(event) => setNumericColumn(event.target.value)}>{numericColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
            <label className="field"><span>Histogram bins · {bins}</span><input type="range" min="5" max="80" value={bins} onChange={(event) => setBins(Number(event.target.value))} /></label>
            {selectedNumericProfile && <div className="metric-list">
              <div><span>Mean</span><strong>{format(selectedNumericProfile.mean)}</strong></div>
              <div><span>Median</span><strong>{format(selectedNumericProfile.median)}</strong></div>
              <div><span>Std. deviation</span><strong>{format(selectedNumericProfile.std)}</strong></div>
              <div><span>IQR</span><strong>{format(selectedNumericProfile.iqr)}</strong></div>
              <div><span>Skewness</span><strong>{format(selectedNumericProfile.skewness)}</strong></div>
              <div><span>Kurtosis</span><strong>{format(selectedNumericProfile.kurtosis)}</strong></div>
              {mode === 'expert' && <>
                <div><span>Variance</span><strong>{format(selectedNumericProfile.variance)}</strong></div>
                <div><span>MAD</span><strong>{format(selectedNumericProfile.mad)}</strong></div>
                <div><span>SEM</span><strong>{format(selectedNumericProfile.sem)}</strong></div>
                <div><span>95% mean CI</span><strong>{format(selectedNumericProfile.ci95_low)} – {format(selectedNumericProfile.ci95_high)}</strong></div>
              </>}
            </div>}
          </aside>
          <div className="analysis-main-stack">
            <article className="analysis-card histogram-card">
              <div className="card-heading"><div><h2>Histogram</h2><p>{distribution?.count.toLocaleString() ?? 0} valid observations</p></div>{loading && <LoaderCircle size={15} className="spin" />}</div>
              {!distribution && <WorkspaceState loading={distributionLoading} title={distributionLoading ? 'Computing distribution' : !numericColumn ? 'No numeric columns' : 'Distribution unavailable'}>{!numericColumn ? 'This dataset contains no numeric measurements. Review its column profile or choose another dataset.' : 'Results will appear here when the analysis completes.'}</WorkspaceState>}{distribution && <>
                <div className="histogram-bars" aria-label={`Histogram of ${numericColumn}`}>{distribution.histogram.counts.map((count, index) => <div key={index} title={`${count.toLocaleString()} observations`} style={{ height: `${count ? Math.max(1, count / histogramMax * 100) : 0}%` }} />)}</div>
                <div className="histogram-axis"><span>{format(distribution.histogram.edges[0])}</span><span>{format(distribution.histogram.edges.at(-1))}</span></div>
              </>}
            </article>
            {distribution && <QuantilePlot points={distribution.qq_plot} column={numericColumn} />}{distribution && <article className="analysis-card normality-card">
              <div className="card-heading"><div><h2>Distribution diagnostics</h2><p>1.5 × IQR outlier rule · Normality sample: {distribution.normality_sample_size.toLocaleString()}{distribution.sampling_seed != null ? ` · seed ${distribution.sampling_seed}` : ''}</p></div><span className={`result-chip ${distribution.likely_normal ? 'positive' : 'neutral'}`}>{distribution.likely_normal == null ? 'Not evaluable' : distribution.likely_normal ? 'Normality not rejected' : 'Evidence against normality'}</span></div>
              <div className="diagnostic-grid">
                <div className="box-summary"><span>Min</span><strong>{format(distribution.boxplot.minimum)}</strong></div>
                <div className="box-summary"><span>Q1</span><strong>{format(distribution.boxplot.q1)}</strong></div>
                <div className="box-summary"><span>Median</span><strong>{format(distribution.boxplot.median)}</strong></div>
                <div className="box-summary"><span>Q3</span><strong>{format(distribution.boxplot.q3)}</strong></div>
                <div className="box-summary"><span>Max</span><strong>{format(distribution.boxplot.maximum)}</strong></div>
                <div className="box-summary"><span>Outliers</span><strong>{distribution.boxplot.outliers.toLocaleString()}</strong></div>
              </div>
              <div className="normality-tests">{distribution.normality_tests.map((test) => <div key={test.name}><span>{test.name}</span><strong>p = {format(test.p_value, 4)}</strong><em>{test.p_value == null ? 'Not evaluable' : test.p_value >= 0.05 ? 'No rejection' : 'Reject normality'}</em></div>)}</div>
              {mode === 'guided' && <p className="plain-note"><Info size={13} />A small p-value means the data provides evidence against a normal distribution. With very large samples, minor departures can become significant.</p>}
            </article>}
          </div>
        </section>
      )}

      {profile && tab === 'relationships' && (
        <section className="analysis-grid relationship-layout">
          <aside className="analysis-controls-card">
            <h2>Correlation setup</h2><p>Measure monotonic or linear relationships.</p>
            <label className="field"><span>Method</span><select className="control" value={correlationMethod} onChange={(event) => setCorrelationMethod(event.target.value)}><option value="pearson">Pearson · linear</option><option value="spearman">Spearman · ranked</option><option value="kendall">Kendall τ · ranked</option></select></label>
            <div className="field"><span>Columns · {correlationColumns.length} selected</span><div className="check-list">{numericColumns.map((column) => <label key={column.name}><input type="checkbox" checked={correlationColumns.includes(column.name)} disabled={!correlationColumns.includes(column.name) && correlationColumns.length >= 30} onChange={() => setCorrelationColumns(correlationColumns.includes(column.name) ? correlationColumns.filter((item) => item !== column.name) : [...correlationColumns, column.name])} /><span className="custom-check">{correlationColumns.includes(column.name) && <CheckCircle2 size={11} />}</span>{column.name}</label>)}</div></div>
            {mode === 'guided' && <p className="plain-note"><Info size={13} />Correlation ranges from −1 to +1. It measures association, not causation.</p>}
          </aside>
          <article className="analysis-card correlation-card">
            <div className="card-heading"><div><h2>{correlationMethod[0].toUpperCase() + correlationMethod.slice(1)} correlation</h2><p>Markers: adjusted p &lt; .05 · Benjamini–Hochberg correction · pairwise complete observations.</p></div>{loading && <LoaderCircle size={15} className="spin" />}</div>
            {!correlation && <WorkspaceState loading={correlationLoading} title={correlationLoading ? 'Computing relationships' : 'Select at least two numeric columns'}>Choose columns in Correlation setup. A dataset needs two numeric variables for this analysis.</WorkspaceState>}{correlation && <div className="correlation-scroll"><table className="correlation-matrix"><thead><tr><th /><>{correlation.columns.map((column) => <th key={column} title={column}>{column}</th>)}</></tr></thead><tbody>{correlation.columns.map((row, rowIndex) => <tr key={row}><th>{row}</th>{correlation.columns.map((column, columnIndex) => { const value = correlation.values[rowIndex][columnIndex]; const significant = (correlation.adjusted_p_values[rowIndex][columnIndex] ?? 1) < .05; return <td key={column} style={{ background: correlationColor(value), color: value != null && Math.abs(value) > .55 ? 'white' : undefined }} title={`r=${format(value)} · p=${format(correlation.p_values[rowIndex][columnIndex], 4)} · adjusted p=${format(correlation.adjusted_p_values[rowIndex][columnIndex], 4)} · n=${correlation.sample_sizes[rowIndex][columnIndex]}`}>{format(value, 2)}{significant && rowIndex !== columnIndex ? <sup>•</sup> : null}</td> })}</tr>)}</tbody></table></div>}
          </article>
        </section>
      )}

      {profile && tab === 'tests' && (
        <section className="analysis-grid test-layout">
          <aside className="analysis-controls-card test-controls">
            <h2>Test setup</h2><p>Select a method and define the variables.</p>
            <label className="field"><span>Method</span><select className="control" value={testName} onChange={(event) => { setTestName(event.target.value); setColumnB(event.target.value === 'chi_square' ? categoricalColumns[1]?.name ?? '' : numericColumns[1]?.name ?? ''); setTestResult(null) }}>{TESTS.map((test) => <option key={test.value} value={test.value}>{test.label}</option>)}</select><small>{currentTest.use}</small></label>
            {currentTest.kind === 'categorical' ? <>
              <label className="field"><span>First categorical column</span><select className="control" value={groupColumn} onChange={(event) => setGroupColumn(event.target.value)}>{categoricalColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
              <label className="field"><span>Second categorical column</span><select className="control" value={columnB} onChange={(event) => setColumnB(event.target.value)}>{categoricalColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
            </> : <label className="field"><span>{currentTest.kind === 'pair' ? 'First numeric column' : 'Numeric outcome'}</span><select className="control" value={columnA} onChange={(event) => setColumnA(event.target.value)}>{numericColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>}
            {currentTest.kind === 'pair' && <label className="field"><span>Second numeric column</span><select className="control" value={columnB} onChange={(event) => setColumnB(event.target.value)}>{numericColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>}
            {currentTest.kind === 'group' && <label className="field"><span>Grouping column</span><select className="control" value={groupColumn} onChange={(event) => setGroupColumn(event.target.value)}>{categoricalColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>}
            {['independent_t', 'mann_whitney'].includes(testName) && groupColumn && <>
              <label className="field"><span>First group</span><input className="control" list="group-options" value={groupA} onChange={event => setGroupA(event.target.value)} /></label>
              <label className="field"><span>Second group</span><input className="control" list="group-options" value={groupB} onChange={event => setGroupB(event.target.value)} /><small>Choose a suggested group or type its exact value. Suggestions show the most frequent categories.</small></label>
              <datalist id="group-options">{profile.column_profiles.find(column => column.name === groupColumn)?.top_values?.map(item => <option key={item.value} value={item.value} />)}</datalist>
            </>}
            {currentTest.kind === 'one' && <label className="field"><span>Hypothesized mean</span><input className="control" type="number" value={targetMean} onChange={(event) => setTargetMean(Number(event.target.value))} /></label>}
            {mode === 'expert' && <label className="field"><span>Significance level α</span><select className="control" value={alpha} onChange={(event) => setAlpha(Number(event.target.value))}><option value={0.1}>0.10</option><option value={0.05}>0.05</option><option value={0.01}>0.01</option></select></label>}
            {((currentTest.kind !== 'categorical' && !columnA) || (currentTest.kind === 'pair' && (!columnB || columnA === columnB)) || (currentTest.kind === 'group' && !groupColumn) || (currentTest.kind === 'categorical' && (!groupColumn || !columnB || groupColumn === columnB))) && <p className="caution-note">This method requires {currentTest.kind === 'categorical' ? 'two distinct categorical columns' : currentTest.kind === 'pair' ? 'two distinct numeric columns' : currentTest.kind === 'group' ? 'a numeric outcome and a categorical grouping column' : 'a numeric column'}. Choose another method or dataset.</p>}
            <button className="button primary run-test" type="button" onClick={runTest} disabled={testLoading || (['independent_t', 'mann_whitney'].includes(testName) && (!groupA || !groupB || groupA === groupB)) || (currentTest.kind !== 'categorical' && !columnA) || (currentTest.kind === 'pair' && (!columnB || columnA === columnB)) || (currentTest.kind === 'group' && !groupColumn) || (currentTest.kind === 'categorical' && (!groupColumn || !columnB || groupColumn === columnB))}>{testLoading ? <><LoaderCircle className="spin" size={14} />Running…</> : 'Run analysis'}</button>
          </aside>
          <div className="analysis-main-stack">
            {!testResult ? <article className="analysis-card test-placeholder"><FlaskConical size={25} /><h2>Ready when you are</h2><p>Configure the analysis on the left. Results include the test statistic, p-value, degrees of freedom, effect size, and a plain-language interpretation.</p></article> : <article className="analysis-card test-result-card">
              <div className="result-heading"><span className={`result-status ${testResult.significant ? 'significant' : ''}`}>{testResult.significant ? <CheckCircle2 size={18} /> : <Info size={18} />}</span><div><span>Result</span><h2>{testResult.name}</h2></div></div>
              <div className="result-statement"><strong>{testResult.interpretation}</strong><p>{testResult.null_hypothesis}</p></div>
              <div className="result-metrics"><div><span>{testResult.statistic_label}</span><strong>{format(testResult.statistic)}</strong></div><div><span>p-value</span><strong>{format(testResult.p_value, 5)}</strong></div><div><span>df</span><strong>{testResult.df ?? '—'}</strong></div><div><span>{testResult.effect_name ?? 'Effect size'}</span><strong>{format(testResult.effect_size)}</strong></div></div>
              {mode === 'expert' && <div className="expert-output"><div><span>Alpha</span><strong>{testResult.alpha}</strong></div>{typeof testResult.slope === 'number' && <div><span>Slope</span><strong>{format(testResult.slope)}</strong></div>}{typeof testResult.intercept === 'number' && <div><span>Intercept</span><strong>{format(testResult.intercept)}</strong></div>}{typeof testResult.standard_error === 'number' && <div><span>Std. error</span><strong>{format(testResult.standard_error)}</strong></div>}</div>}
              <p className="plain-note">Analyzed: {String(testResult.n ?? "—")} observations · Excluded or unselected: {String(testResult.excluded_rows ?? 0)} rows</p>{Number(testResult.small_expected_cells) > 0 && <p className="caution-note">{String(testResult.small_expected_cells)} expected cells are below 5. The chi-square approximation may be unreliable.</p>}<p className="caution-note"><AlertCircle size={13} />{testResult.caution}</p>
            </article>}
            {mode === 'guided' && <article className="analysis-card method-guide"><h2>Choosing the right test</h2><div><strong>Means, two independent groups</strong><span>Welch’s t-test; use Mann–Whitney for strongly non-normal or ordinal data.</span></div><div><strong>Means, three or more groups</strong><span>ANOVA; use Kruskal–Wallis when parametric assumptions are unsuitable.</span></div><div><strong>Same subjects measured twice</strong><span>Paired t-test; use Wilcoxon signed-rank for non-normal differences.</span></div><div><strong>Two categorical variables</strong><span>Chi-square test of independence.</span></div></article>}
          </div>
        </section>
      )}

      {profile && tab === 'time' && (
        <section className="analysis-grid time-diagnostics-layout">
          <aside className="analysis-controls-card">
            <h2>Time-series diagnostics</h2><p>Quantify trend, cadence, and serial dependence.</p>
            <label className="field"><span>Date/time column</span><select className="control" value={timestampColumn} onChange={(event) => setTimestampColumn(event.target.value)}><option value="">Choose a column</option>{profile.column_profiles.filter((column) => column.type === 'datetime').map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
            <label className="field"><span>Numeric measurement</span><select className="control" value={numericColumn} onChange={(event) => setNumericColumn(event.target.value)}>{numericColumns.map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
            {mode === 'guided' && <p className="plain-note"><Info size={13} />Autocorrelation shows how strongly a series resembles its earlier values. High values at repeated lags may indicate persistence or seasonality.</p>}
          </aside>
          <div className="analysis-main-stack">
            {!timestampColumn || !numericColumn ? <article className="analysis-card test-placeholder"><BarChart3 size={25} /><h2>Date/time and numeric columns required</h2><p>Configure a timestamp during import or choose a column that contains parseable dates.</p></article> : !timeDiagnostics ? <WorkspaceState loading={timeLoading} title={timeLoading ? 'Computing time diagnostics' : 'Time diagnostics unavailable'}>Trend and autocorrelation results will appear here.</WorkspaceState> : <>
              <p className="caution-note">{timeDiagnostics.caution}{timeDiagnostics.irregular_intervals ? " Irregular sampling detected." : ""} {timeDiagnostics.duplicate_timestamps} duplicate timestamps.</p><section className="stat-grid diagnostics-stats"><article className="stat-card"><span>Observations</span><strong>{timeDiagnostics.count.toLocaleString()}</strong><p>Complete time-value pairs</p></article><article className="stat-card"><span>Median cadence</span><strong>{format(timeDiagnostics.median_interval_seconds)}<small> sec</small></strong><p>Typical interval</p></article><article className="stat-card"><span>Trend per day</span><strong>{format(timeDiagnostics.trend_per_day)}</strong><p>p = {format(timeDiagnostics.trend_p_value, 4)}</p></article><article className="stat-card"><span>Trend R²</span><strong>{format(timeDiagnostics.r_squared)}</strong><p>Linear variance explained</p></article></section>
              <article className="analysis-card autocorrelation-card"><div className="card-heading"><div><h2>Autocorrelation function</h2><p>Lag 1 through {timeDiagnostics.lags.at(-1)} · values range from −1 to +1</p></div>{loading && <LoaderCircle size={15} className="spin" />}</div><div className="acf-chart">{timeDiagnostics.autocorrelation.map((value, index) => <div key={timeDiagnostics.lags[index]} title={`Lag ${timeDiagnostics.lags[index]}: ${format(value)}`}><span style={{ height: `${Math.abs(value ?? 0) * 50}%`, bottom: (value ?? 0) >= 0 ? '50%' : 'auto', top: (value ?? 0) < 0 ? '50%' : 'auto', background: (value ?? 0) >= 0 ? '#176b52' : '#b74655' }} /></div>)}</div><div className="acf-axis"><span>Lag 1</span><span>Zero</span><span>Lag {timeDiagnostics.lags.at(-1)}</span></div></article>
            </>}
          </div>
        </section>
      )}
    </>
  )
}
