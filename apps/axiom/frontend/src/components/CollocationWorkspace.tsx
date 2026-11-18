import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  Check,
  ChevronDown,
  CircleGauge,
  Clock3,
  Download,
  FileSpreadsheet,
  FlaskConical,
  Info,
  LoaderCircle,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import {
  analyzeCollocation,
  getCollocationSessions,
  getDriftComparison,
  inspectSheet,
  inspectUpload,
  saveCollocationSession,
} from '../api'
import type {
  CollocationQualityGates,
  CollocationResult,
  DriftComparison,
  ImportInspection,
  SavedCollocationSession,
} from '../types'
import { CollocationChart } from './CollocationChart'
import { csvCell, downloadFile } from '../export'

interface SensorFile {
  key: string
  inspection: ImportInspection
  sensorName: string
  dateColumn: string
  timeColumn: string
  measurementColumn: string
  sourceUnit: string
  temperatureColumn: string
  humidityColumn: string
  dayFirst: boolean
  role: 'sensor' | 'reference'
}

const DEFAULT_GATES: CollocationQualityGates = {
  completeness: 80,
  ccc: 0.9,
  nrmse: 20,
  relative_bias: 10,
  absolute_rmse: null,
  slope_min: 0.85,
  slope_max: 1.15,
}

function cleanName(filename: string) {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (value) => value.toUpperCase())
}

function recommendedColumn(inspection: ImportInspection) {
  return inspection.suggestions.measurements[0] ?? inspection.columns.find((column) => column.type === 'number')?.name ?? ''
}

function resultCsv(result: CollocationResult) {
  const sensors = result.pairwise.sensors
  const rows = [`timestamp,consensus,${sensors.map(csvCell).join(',')}`]
  result.series.forEach((point) => rows.push([
    new Date(point.timestamp).toISOString(),
    point.consensus ?? '',
    ...sensors.map((sensor) => point.values[sensor] ?? ''),
  ].join(',')))
  return rows.join('\n')
}

function correctedCsv(result: CollocationResult, approved: Set<string>) {
  const sensors = result.pairwise.sensors.filter((sensor) => approved.has(sensor))
  const headers = sensors.flatMap((sensor) => [`${sensor} raw`, `${sensor} corrected`])
  const rows = [`timestamp,consensus,${headers.map(csvCell).join(',')}`]
  result.series.forEach((point) => rows.push([
    new Date(point.timestamp).toISOString(),
    point.consensus ?? '',
    ...sensors.flatMap((sensor) => [point.values[sensor] ?? '', point.corrected[sensor] ?? '']),
  ].join(',')))
  return rows.join('\n')
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return <article className="collocation-metric"><span>{label}</span><strong>{value}</strong><small>{note}</small></article>
}

export function CollocationWorkspace() {
  const fileInput = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<SensorFile[]>([])
  const [studyName, setStudyName] = useState('New collocation study')
  const [parameter, setParameter] = useState('')
  const [unit, setUnit] = useState('')
  const [resolution, setResolution] = useState('1min')
  const [comparisonMode, setComparisonMode] = useState<'ensemble' | 'reference'>('ensemble')
  const [scaleType, setScaleType] = useState<'ratio' | 'interval' | 'logarithmic' | 'other'>('ratio')
  const [minimumPeerCount, setMinimumPeerCount] = useState(2)
  const [minimumDurationHours, setMinimumDurationHours] = useState(8)
  const [minimumPairedBins, setMinimumPairedBins] = useState(100)
  const [sessionRole, setSessionRole] = useState<'baseline' | 'follow_up' | 'post_deployment'>('baseline')
  const [sessionLabel, setSessionLabel] = useState('Baseline')
  const [environment, setEnvironment] = useState('Indoor')
  const [baselineId, setBaselineId] = useState('')
  const [savedSessions, setSavedSessions] = useState<SavedCollocationSession[]>([])
  const [gates, setGates] = useState(DEFAULT_GATES)
  const [advanced, setAdvanced] = useState(false)
  const [loadingFiles, setLoadingFiles] = useState(0)
  const [running, setRunning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CollocationResult | null>(null)
  const [alignmentReview, setAlignmentReview] = useState<CollocationResult | null>(null)
  const [resultTab, setResultTab] = useState<'overview' | 'agreement' | 'corrections' | 'methods' | 'drift'>('overview')
  const [drift, setDrift] = useState<DriftComparison | null>(null)
  const [approvedCorrections, setApprovedCorrections] = useState<Set<string>>(new Set())
  const alignmentDialog = useRef<HTMLElement>(null)
  const alignmentBusy = useRef(running)
  alignmentBusy.current = running
  useEffect(() => {
    if (!alignmentReview) return
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    alignmentDialog.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !alignmentBusy.current) setAlignmentReview(null)
      if (event.key !== 'Tab') return
      const controls = Array.from(alignmentDialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])
      const first = controls[0], last = controls.at(-1)
      if (!first) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === alignmentDialog.current)) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === alignmentDialog.current)) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); previous?.focus() }
  }, [alignmentReview])

  const completeFiles = files.filter((file) => file.dateColumn && file.measurementColumn && file.sensorName.trim())
  const referenceCount = completeFiles.filter((file) => file.role === 'reference').length
  const targetCount = completeFiles.filter((file) => file.role === 'sensor').length
  const authorityReady = comparisonMode === 'ensemble'
    ? completeFiles.length >= Math.max(3, minimumPeerCount + 1)
    : referenceCount === 1 && targetCount >= 1
  const duplicateNames = new Set(files.map(file => file.sensorName.trim().toLowerCase())).size !== files.length
  const validGates = gates.completeness >= 0 && gates.completeness <= 100 && gates.ccc >= -1 && gates.ccc <= 1 && gates.slope_min <= gates.slope_max && (gates.nrmse == null || gates.nrmse >= 0) && (gates.relative_bias == null || gates.relative_bias >= 0) && (gates.absolute_rmse == null || gates.absolute_rmse >= 0) && Number.isInteger(minimumPeerCount) && minimumPeerCount >= 2
  const runReason = loadingFiles ? 'Wait for file inspection to finish.' : duplicateNames ? 'Give every sensor a unique name.' : completeFiles.length !== files.length ? 'Complete the timestamp, measurement, and name for every file.' : !authorityReady ? comparisonMode === 'ensemble' ? `Add at least ${Math.max(3, minimumPeerCount + 1)} sensors.` : 'Add exactly one reference and at least one sensor.' : !parameter.trim() ? 'Name the shared analysis parameter.' : !studyName.trim() ? 'Give this study a name.' : !validGates ? 'Review quality gates: percentages must be nonnegative, completeness at most 100%, CCC between -1 and 1, slope minimum no greater than maximum, and peer count an integer of at least 2.' : ''
  const ready = !runReason && !running
  const mappedMeasurementNames = useMemo(() => new Set(files.map((file) => file.measurementColumn).filter(Boolean)).size, [files])
  const compatibleBaselines = savedSessions.filter((session) => session.role === 'baseline' && (!parameter || session.parameter === parameter))

  useEffect(() => {
    const controller = new AbortController()
    getCollocationSessions(controller.signal).then(setSavedSessions).catch(() => undefined)
    return () => controller.abort()
  }, [])

  const addFiles = async (incoming: FileList | File[]) => {
    const selected = Array.from(incoming)
    if (!selected.length || running || loadingFiles) return
    setError(null)
    setLoadingFiles((count) => count + selected.length)
    const settled = await Promise.allSettled(selected.map(async (file, index) => {
      const inspection = await inspectUpload(file)
      return {
        key: `${inspection.upload_id}-${index}`,
        inspection,
        sensorName: cleanName(file.name),
        dateColumn: inspection.suggestions.date_column ?? '',
        timeColumn: inspection.suggestions.time_column ?? '',
        measurementColumn: recommendedColumn(inspection),
        sourceUnit: '',
        temperatureColumn: '',
        humidityColumn: '',
        dayFirst: true,
        role: 'sensor',
      } satisfies SensorFile
    }))
    const added = settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : [])
    const failures = settled.flatMap((item) => item.status === 'rejected' ? [item.reason] : [])
    setFiles((current) => {
      const needsReference = comparisonMode === 'reference' && !current.some((file) => file.role === 'reference')
      const normalized = added.map((file, index) => ({
        ...file,
        role: needsReference && index === 0 ? 'reference' as const : file.role,
      }))
      return [...current, ...normalized]
    })
    if (!parameter && added[0]?.measurementColumn) setParameter(added[0].measurementColumn)
    if (failures.length) setError(failures[0] instanceof Error ? failures[0].message : 'One or more files could not be inspected')
    setLoadingFiles((count) => count - selected.length)
  }

  const updateFile = (key: string, change: Partial<SensorFile>) => {
    setFiles((current) => current.map((file) => file.key === key ? { ...file, ...change } : file))
  }

  const changeComparisonMode = (mode: 'ensemble' | 'reference') => {
    setComparisonMode(mode)
    setFiles((current) => current.map((file, index) => ({
      ...file,
      role: mode === 'reference' && index === 0 ? 'reference' : 'sensor',
    })))
  }

  const changeFileRole = (key: string, role: 'sensor' | 'reference') => {
    setFiles((current) => current.map((file) => ({
      ...file,
      role: file.key === key ? role : role === 'reference' && file.role === 'reference' ? 'sensor' : file.role,
    })))
  }

  const changeSheet = async (file: SensorFile, sheet: string) => {
    setLoadingFiles((count) => count + 1)
    setError(null)
    try {
      const inspection = await inspectSheet(file.inspection.upload_id, sheet)
      updateFile(file.key, {
        inspection: { ...inspection, filename: file.inspection.filename, size: file.inspection.size },
        dateColumn: inspection.suggestions.date_column ?? '',
        timeColumn: inspection.suggestions.time_column ?? '',
        measurementColumn: recommendedColumn(inspection),
      })
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The worksheet could not be read')
    } finally {
      setLoadingFiles((count) => count - 1)
    }
  }

  const acceptResult = (response: CollocationResult) => {
    setResult(response)
    setAlignmentReview(null)
    setApprovedCorrections(new Set())
    setSavedId(null)
    setDrift(null)
    setResultTab('overview')
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const run = async (applySuggestedLag = false) => {
    if (!ready) return
    setRunning(true)
    setError(null)
    try {
      const response = await analyzeCollocation({
        study_name: studyName.trim(),
        parameter_name: parameter.trim(),
        unit: unit.trim(),
        resolution,
        minimum_bin_coverage: 75,
        max_lag_minutes: 10,
        apply_suggested_lag: applySuggestedLag,
        comparison_mode: comparisonMode,
        scale_type: scaleType,
        minimum_peer_count: minimumPeerCount,
        minimum_duration_hours: minimumDurationHours,
        minimum_paired_bins: minimumPairedBins,
        members: completeFiles.map((file) => ({
          upload_id: file.inspection.upload_id,
          filename: file.inspection.filename,
          sheet: file.inspection.selected_sheet,
          sensor_name: file.sensorName.trim(),
          date_column: file.dateColumn,
          time_column: file.timeColumn || null,
          measurement_column: file.measurementColumn,
          source_unit: file.sourceUnit,
          temperature_column: file.temperatureColumn || null,
          humidity_column: file.humidityColumn || null,
          day_first: file.dayFirst,
          role: file.role,
        })),
        quality_gates: gates,
      })
      const hasSuggestedShift = response.alignments.some((item) => item.suggested_lag_minutes !== 0)
      if (!applySuggestedLag && hasSuggestedShift) setAlignmentReview(response)
      else acceptResult(response)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The collocation analysis could not be completed')
    } finally {
      setRunning(false)
    }
  }

  const saveResult = async () => {
    if (!result || savedId) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveCollocationSession({
        label: sessionLabel.trim() || 'Collocation session',
        role: sessionRole,
        environment,
        result,
      })
      setSavedId(saved.id)
      setSavedSessions((current) => [saved, ...current])
      if (sessionRole !== 'baseline' && baselineId) {
        const comparison = await getDriftComparison(baselineId, saved.id)
        setDrift(comparison)
        setResultTab('drift')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The collocation session could not be saved')
    } finally {
      setSaving(false)
    }
  }

  if (result) {
    const statusReady = result.summary.status === 'Ready'
    const statusInsufficient = result.summary.status === 'Insufficient evidence'
    return (
      <div className="collocation-workspace result-mode">
        <section className="collocation-result-head">
          <div>
            <button className="text-action" type="button" onClick={() => setResult(null)}><RotateCcw size={13} /> Edit setup</button>
            <div className="eyebrow"><FlaskConical size={14} /> Collocation report</div>
            <h1>{result.study.name}</h1>
            <p>{result.study.parameter}{result.study.unit ? ` · ${result.study.unit}` : ''} · {new Date(result.summary.start).toLocaleDateString()} – {new Date(result.summary.end).toLocaleDateString()}</p>
          </div>
          <div className="heading-actions">
            <button className="button secondary" type="button" onClick={() => downloadFile('collocation-aligned.csv', resultCsv(result), 'text/csv')}><Download size={15} /> Export data</button>
            <button className="button secondary" type="button" onClick={() => window.print()}><FileSpreadsheet size={15} /> PDF report</button>
            <button className="button primary" type="button" onClick={saveResult} disabled={saving || Boolean(savedId)}>{saving ? <LoaderCircle className="spin" size={15} /> : savedId ? <Check size={15} /> : <ShieldCheck size={15} />} {savedId ? 'Session saved' : `Save ${sessionRole === 'baseline' ? 'baseline' : 'session'}`}</button>
          </div>
        </section>

        <section className={`readiness-banner ${statusReady ? 'ready' : statusInsufficient ? 'insufficient' : 'review'}`}>
          <span className="readiness-icon">{statusReady ? <BadgeCheck size={22} /> : <AlertCircle size={22} />}</span>
          <div><strong>{statusReady ? 'Fleet is ready for deployment' : statusInsufficient ? 'More evidence is required' : 'Review recommended before deployment'}</strong><p>{statusInsufficient ? `${result.summary.insufficient_sensors} sensors did not meet the configured duration or paired-observation requirement.` : `${result.summary.ready_sensors} of ${result.summary.sensor_count} sensors meet every configured quality gate.`}</p></div>
          <span className="readiness-score">{result.summary.ready_sensors}/{result.summary.sensor_count}</span>
        </section>

        <nav className="result-nav" aria-label="Collocation report sections">
          {(['overview', 'agreement', 'corrections', 'methods'] as const).map((tab) => <button key={tab} aria-pressed={resultTab === tab} className={resultTab === tab ? 'active' : ''} onClick={() => setResultTab(tab)} type="button">{tab === 'overview' ? 'Executive overview' : tab[0].toUpperCase() + tab.slice(1)}</button>)}
          {drift && <button className={resultTab === 'drift' ? 'active' : ''} onClick={() => setResultTab('drift')} type="button">Drift since baseline</button>}
        </nav>

        {resultTab === 'overview' && <>
          <section className="collocation-metric-grid">
            <Metric label="Concordance" value={result.summary.fleet_ccc?.toFixed(3) ?? '—'} note="Median Lin’s CCC" />
            <Metric label={result.study.comparison_mode === 'reference' ? 'Authority' : 'Absolute reliability'} value={result.study.comparison_mode === 'reference' ? 'Reference' : result.summary.icc_single?.toFixed(3) ?? '—'} note={result.study.comparison_mode === 'reference' ? result.study.reference ?? 'External instrument' : 'ICC(A,1), single sensor'} />
            <Metric label="Completeness" value={`${result.summary.median_completeness.toFixed(1)}%`} note="Median paired availability" />
            <Metric label="Overlap" value={`${result.summary.duration_hours.toFixed(1)} h`} note={`${result.summary.paired_bins.toLocaleString()} aligned bins`} />
            <Metric label="Fleet variability" value={result.summary.median_fleet_cv == null ? '—' : `${result.summary.median_fleet_cv.toFixed(1)}%`} note={`Median CV · ${result.summary.resolution.replace('min', ' min')}`} />
          </section>
          <section className="collocation-panel chart-panel">
            <div className="panel-heading"><div><span>Aligned response</span><h2>{result.study.comparison_mode === 'reference' ? 'Sensors against external reference' : 'Sensors against fleet consensus'}</h2><p>The dark line is the {result.study.comparison_mode === 'reference' ? 'selected reference signal' : 'median fleet signal'}; hover to inspect synchronized values.</p></div><span className="method-pill">{result.study.comparison_mode === 'reference' ? 'Reference-linked' : `Leave-one-out · ≥${result.minimum_requirements.peer_count} peers`}</span></div>
            <CollocationChart result={result} />
          </section>
          <section className="collocation-panel">
            <div className="panel-heading"><div><span>Decision summary</span><h2>Sensor readiness</h2><p>Every outcome is evaluated against your configured acceptance criteria.</p></div></div>
            <SensorTable result={result} />
          </section>
          <section className="science-note"><Info size={16} /><div><strong>{result.study.comparison_mode === 'reference' ? 'Reference validity governs the accuracy claim' : 'Interpret these results as relative agreement'}</strong><p>{result.warnings.join(' ')}</p></div></section>
        </>}

        {resultTab === 'agreement' && <div className="agreement-layout">
          <section className="collocation-panel">
            <div className="panel-heading"><div><span>Pairwise Pearson r</span><h2>Agreement matrix</h2><p>Quickly locate sensor pairs that move differently.</p></div></div>
            <div className="pairwise-wrap"><table className="pairwise-table"><thead><tr><th></th>{result.pairwise.sensors.map((sensor) => <th key={sensor}>{sensor}</th>)}</tr></thead><tbody>{result.pairwise.sensors.map((sensor, row) => <tr key={sensor}><th>{sensor}</th>{result.pairwise.values[row].map((value, column) => <td key={column} style={{ background: value == null ? '#f3f4f3' : `rgba(23,107,82,${Math.max(.06, value * .88)})`, color: value != null && value > .62 ? 'white' : '#34403a' }}>{value?.toFixed(2) ?? '—'}</td>)}</tr>)}</tbody></table></div>
          </section>
          <section className="collocation-panel">
            <div className="panel-heading"><div><span>Clock diagnostics</span><h2>Alignment suggestions</h2><p>Estimated from changes in the shared fleet signal.</p></div></div>
            <div className="alignment-list">{result.alignments.map((item) => <div key={item.sensor}><span className={item.status === 'Aligned' ? 'ok-dot' : 'review-dot'} /><strong>{item.sensor}</strong><span>{item.suggested_lag_minutes === 0 ? 'No shift suggested' : `${item.suggested_lag_minutes > 0 ? '+' : ''}${item.suggested_lag_minutes} min`}</span><small>r {item.correlation?.toFixed(3) ?? '—'}</small></div>)}</div>
          </section>
          <section className="collocation-panel full-span"><SensorTable result={result} detailed /></section>
          <section className="collocation-panel full-span range-panel"><div className="panel-heading"><div><span>Response-dependent performance</span><h2>Bias across the measurement range</h2><p>Low, middle, and high strata are defined from benchmark tertiles, independently for each sensor comparison.</p></div><span className="method-pill">Benchmark tertiles</span></div><RangeBias result={result} /></section>
          <section className="science-note full-span"><ShieldCheck size={16} /><div><strong>Uncertainty preserves time dependence</strong><p>Bias and agreement-limit confidence intervals use 500-replicate circular moving-block bootstrap samples. Block length adapts to residual lag-one autocorrelation; intervals are withheld below 20 paired observations.</p></div></section>
        </div>}

        {resultTab === 'corrections' && <section className="collocation-panel">
          <div className="panel-heading"><div><span>Correction candidates</span><h2>Validated harmonization profiles</h2><p>The simplest adequate model is chosen with contiguous time-block validation. Review each profile before export.</p></div>{approvedCorrections.size > 0 ? <button className="button primary compact-button" type="button" onClick={() => downloadFile('collocation-corrected.csv', correctedCsv(result, approvedCorrections), 'text/csv')}><Download size={13} /> Export {approvedCorrections.size} approved</button> : <span className="method-pill">Proposed · approval required</span>}</div>
          {result.corrections.length ? <div className="correction-list">{result.corrections.map((item) => { const approved = approvedCorrections.has(item.sensor); return <article className={approved ? 'approved' : ''} key={item.sensor}><div className="correction-title"><span>{approved ? <Check size={15} /> : <Sparkles size={15} />}</span><div><strong>{item.sensor}</strong><small>{item.model} · {item.validation_folds}-fold blocked validation</small></div><b>{item.validation_improvement_percent.toFixed(1)}% <em>validated improvement</em></b></div><code>{item.formula}</code><div className="correction-stats"><span>Identity CV RMSE <strong>{item.identity_validation_rmse}</strong></span><ArrowRight size={13} /><span>Selected CV RMSE <strong>{item.validation_rmse}</strong></span></div><button type="button" onClick={() => setApprovedCorrections((current) => { const next = new Set(current); if (approved) next.delete(item.sensor); else next.add(item.sensor); return next })}>{approved ? 'Approved · click to withdraw' : 'Review and approve profile'}</button></article> })}</div> : <div className="correction-empty"><ShieldCheck size={20} /><strong>Corrections withheld</strong><p>No model is proposed until a sensor meets the configured minimum duration and paired-observation requirements.</p></div>}
          <div className="science-note compact"><ShieldCheck size={16} /><div><strong>Raw observations remain immutable</strong><p>Corrections are represented as versioned derived values; exporting this report does not overwrite source data.</p></div></div>
        </section>}
        {resultTab === 'methods' && <section className="collocation-panel methods-panel">
          <div className="panel-heading"><div><span>Reproducible methods</span><h2>How this analysis was calculated</h2><p>Definitions and applicability rules are recorded with the session so the result can be audited.</p></div><span className="method-pill">500 bootstrap replicates</span></div>
          <div className="methods-grid">
            <article><span>Comparison authority</span><strong>{result.study.comparison_mode === 'reference' ? result.study.reference : `Leave-one-out median of ≥${result.minimum_requirements.peer_count} peers`}</strong><p>{result.study.comparison_mode === 'reference' ? 'Each sensor is paired with the selected reference at the same accepted analysis bins.' : 'The target sensor is always excluded from its own consensus. Bins with too few peers are discarded.'}</p></article>
            <article><span>Absolute bias</span><code>mean(sensor − benchmark)</code><p>The sign is retained: positive means the sensor reads high. The 95% CI uses a circular moving-block bootstrap.</p></article>
            <article><span>Relative bias</span><code>100 × mean(sensor − benchmark) / mean(benchmark)</code><p>{result.study.scale_type === 'ratio' ? 'Evaluated only when at least 99% of benchmark values are non-negative and its mean is materially above zero.' : `Disabled because “${result.study.scale_type}” is not a ratio scale with a meaningful zero.`}</p></article>
            <article><span>Bland–Altman agreement</span><code>bias ± 1.96 × SD(differences)</code><p>Separate block-bootstrap confidence intervals quantify uncertainty in each agreement limit.</p></article>
            <article><span>Evidence requirement</span><strong>≥{result.minimum_requirements.duration_hours.toLocaleString()} h · ≥{result.minimum_requirements.paired_bins.toLocaleString()} pairs</strong><p>Corrections are withheld and status is Insufficient when either requirement is missed.</p></article>
            <article><span>Correction validation</span><strong>Contiguous time-block folds</strong><p>Identity, offset-only, and robust-linear candidates are compared without random temporal leakage; the simplest model within one standard error is selected.</p></article>
          </div>
          <div className="science-note compact"><Info size={16} /><div><strong>Interpretation boundary</strong><p>{result.study.comparison_mode === 'reference' ? 'Results support accuracy statements only to the extent that the reference is traceable, fit for purpose, and operated within its valid range.' : 'Results quantify relative harmonization. They cannot establish absolute accuracy or detect a bias shared by the entire sensor cohort.'}</p></div></div>
        </section>}
        {resultTab === 'drift' && drift && <section className="collocation-panel drift-panel">
          <div className="panel-heading"><div><span>Longitudinal comparison</span><h2>{drift.baseline.label} → {drift.follow_up.label}</h2><p>{drift.parameter}{drift.unit ? ` · ${drift.unit}` : ''} · matched by sensor name and evaluated against fixed drift thresholds.</p></div><span className={`drift-overall ${drift.status.toLowerCase().replace(' ', '-')}`}>{drift.status}</span></div>
          <div className="drift-session-strip"><div><span>Baseline</span><strong>{new Date(drift.baseline.created_at).toLocaleDateString()}</strong><small>{drift.baseline.environment}</small></div><ArrowRight size={16} /><div><span>Follow-up</span><strong>{new Date(drift.follow_up.created_at).toLocaleDateString()}</strong><small>{drift.follow_up.environment}</small></div></div>
          <div className="table-wrap"><table className="drift-table"><thead><tr><th>Sensor</th><th>Assessment</th><th>{drift.scale_type === 'ratio' ? 'Relative-bias change' : `Bias change (${drift.unit})`}</th><th>Slope change</th><th>{drift.scale_type === 'ratio' ? 'NRMSE change' : `RMSE change (${drift.unit})`}</th><th>CCC change</th></tr></thead><tbody>{drift.sensors.map((sensor) => <tr key={sensor.sensor}><td><strong>{sensor.sensor}</strong></td><td><span className={`drift-chip ${sensor.status.toLowerCase().replace(' ', '-')}`}>{sensor.status}</span></td><td>{drift.scale_type === 'ratio' ? sensor.relative_bias_change == null ? '—' : `${sensor.relative_bias_change > 0 ? '+' : ''}${sensor.relative_bias_change.toFixed(1)} pp` : sensor.absolute_bias_change == null ? '—' : `${sensor.absolute_bias_change > 0 ? '+' : ''}${sensor.absolute_bias_change.toFixed(3)}`}</td><td>{sensor.slope_change_percent == null ? '—' : `${sensor.slope_change_percent > 0 ? '+' : ''}${sensor.slope_change_percent.toFixed(1)}%`}</td><td>{drift.scale_type === 'ratio' ? sensor.nrmse_change == null ? '—' : `${sensor.nrmse_change > 0 ? '+' : ''}${sensor.nrmse_change.toFixed(1)} pp` : sensor.rmse_change == null ? '—' : `${sensor.rmse_change > 0 ? '+' : ''}${sensor.rmse_change.toFixed(3)}`}</td><td>{sensor.ccc_change == null ? '—' : `${sensor.ccc_change > 0 ? '+' : ''}${sensor.ccc_change.toFixed(3)}`}</td></tr>)}</tbody></table></div>
          <div className="science-note compact"><Info size={16} /><div><strong>Drift decisions use change from the saved baseline</strong><p>Signal if relative bias changes by at least 10 percentage points, slope changes by at least 15%, or follow-up NRMSE exceeds 20%. Review common-mode changes against an independent reference when available.</p></div></div>
        </section>}
      </div>
    )
  }

  return (
    <div className="collocation-workspace">
      <section className="collocation-hero">
        <div>
          <div className="eyebrow"><FlaskConical size={14} /> Sensor quality</div>
          <h1>Collocation & drift</h1>
          <p>Align any sensor fleet, quantify agreement, and build defensible correction profiles—without reshaping your source files.</p>
        </div>
        <div className="protocol-badge"><ShieldCheck size={16} /><span><strong>{comparisonMode === 'ensemble' ? 'Ensemble consensus' : 'External reference'}</strong><small>{comparisonMode === 'ensemble' ? `Reference-free · ≥${minimumPeerCount} valid peers` : 'Reference-linked evaluation'}</small></span></div>
      </section>

      <ol className="workflow-steps" aria-label="Analysis progress">
        <li className="active"><span>1</span><div><strong>Upload & map</strong><small>Current step</small></div></li>
        <li className={authorityReady ? 'available' : ''}><span>2</span><div><strong>Alignment & QC</strong><small>Automatic diagnostics</small></div></li>
        <li><span>3</span><div><strong>Agreement</strong><small>Evidence & gates</small></div></li>
        <li><span>4</span><div><strong>Corrections</strong><small>Review & export</small></div></li>
      </ol>

      {error && <div className="error-banner" role="alert"><AlertCircle size={15} /> {error}</div>}

      <fieldset className="collocation-setup-grid setup-fieldset" disabled={running || loadingFiles > 0}>
        <div className="setup-main">
          <section className="collocation-panel upload-panel">
            <div className="panel-heading"><div><span>Step 1</span><h2>Add sensor files</h2><p>Upload one file per sensor. Axiom reads headers and samples before anything is analyzed.</p></div><b>{files.length} files</b></div>
            <input ref={fileInput} hidden multiple type="file" accept=".csv,.tsv,.txt,.json,.xlsx,.xls" onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = '' }} />
            {files.length === 0 ? <button className={`collocation-drop ${dragging ? 'dragging' : ''}`} type="button" onClick={() => fileInput.current?.click()} onDragEnter={(event) => { event.preventDefault(); setDragging(true) }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files) }}>
              <span><UploadCloud size={24} /></span><strong>{loadingFiles ? 'Reading column names…' : 'Drop all sensor files here'}</strong><p>or click to browse · CSV, text, JSON and Excel · 100 MB each</p><small>Files may use different column names and sampling intervals.</small>
            </button> : <>
              <div className="sensor-map-list">{files.map((file, index) => <SensorMapping key={file.key} file={file} index={index} comparisonMode={comparisonMode} onRole={(role) => changeFileRole(file.key, role)} onChange={(change) => updateFile(file.key, change)} onSheet={(sheet) => changeSheet(file, sheet)} onRemove={() => setFiles((current) => current.filter((item) => item.key !== file.key))} />)}</div>
              <button className="add-sensor-button" type="button" onClick={() => fileInput.current?.click()}><Plus size={15} /> Add more sensor files</button>
            </>}
            {loadingFiles > 0 && <div className="inline-loading"><LoaderCircle className="spin" size={15} /> Inspecting {loadingFiles} {loadingFiles === 1 ? 'file' : 'files'}…</div>}
          </section>
          <section className="collocation-panel study-card">
            <div className="panel-heading"><div><span>Step 2</span><h2>Define the analysis</h2><p>Choose the comparison method and evidence required for this study.</p></div></div><div className="study-fields">
            <label className="field"><span>Study name</span><input className="control" value={studyName} onChange={(event) => setStudyName(event.target.value)} /></label>
            <label className="field"><span>Comparison authority</span><select className="control" value={comparisonMode} onChange={(event) => changeComparisonMode(event.target.value as typeof comparisonMode)}><option value="ensemble">Peer ensemble · relative agreement</option><option value="reference">External reference · accuracy evaluation</option></select><small>{comparisonMode === 'ensemble' ? 'Each sensor is compared with the median of its valid peers.' : 'Mark exactly one uploaded file as the reference instrument.'}</small></label>
            <div className="side-fields"><label className="field"><span>Parameter name</span><input className="control" value={parameter} onChange={(event) => setParameter(event.target.value)} placeholder="e.g. CO₂, NO₂, temperature" /></label><label className="field unit-field"><span>Unit</span><input className="control" value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="ppm" /></label></div>
            <label className="field"><span>Measurement scale</span><select className="control" value={scaleType} onChange={(event) => setScaleType(event.target.value as typeof scaleType)}><option value="ratio">Ratio scale · meaningful zero</option><option value="interval">Interval scale · arbitrary zero</option><option value="logarithmic">Logarithmic scale</option><option value="other">Other / report absolute errors only</option></select><small>{scaleType === 'ratio' ? 'Percentage bias and NRMSE are reported when the benchmark remains positive.' : 'Percentage metrics are disabled; absolute-unit bias and RMSE remain available.'}</small></label>
            <label className="field"><span>Analysis resolution</span><select className="control" value={resolution} onChange={(event) => setResolution(event.target.value)}><option value="1min">1-minute mean</option><option value="5min">5-minute mean</option><option value="15min">15-minute mean</option><option value="1h">1-hour mean</option></select></label>
            <label className="field"><span>Evidence requirement</span><select className="control" value={`${minimumDurationHours}:${minimumPairedBins}`} onChange={(event) => { const [hours, bins] = event.target.value.split(':').map(Number); setMinimumDurationHours(hours); setMinimumPairedBins(bins) }}><option value="8:100">Pilot · ≥8 h and 100 pairs</option><option value="72:500">Deployment · ≥72 h and 500 pairs</option><option value="720:1000">Extended · ≥30 d and 1,000 pairs</option></select></label>
            <div className="side-fields session-fields"><label className="field"><span>Session role</span><select className="control" value={sessionRole} onChange={(event) => { const role = event.target.value as typeof sessionRole; setSessionRole(role); setSessionLabel(role === 'baseline' ? 'Baseline' : role === 'follow_up' ? '60-day follow-up' : 'Post-deployment') }}><option value="baseline">Baseline</option><option value="follow_up">Follow-up</option><option value="post_deployment">Post-deployment</option></select></label><label className="field"><span>Environment</span><select className="control" value={environment} onChange={(event) => setEnvironment(event.target.value)}><option>Indoor</option><option>Outdoor</option><option>Laboratory</option><option>Mixed</option></select></label></div>
            <label className="field"><span>Session label</span><input className="control" value={sessionLabel} onChange={(event) => setSessionLabel(event.target.value)} /></label>
            {sessionRole !== 'baseline' && <label className="field"><span>Compare with baseline</span><select className="control" value={baselineId} onChange={(event) => setBaselineId(event.target.value)}><option value="">Save without comparison</option>{compatibleBaselines.map((session) => <option value={session.id} key={session.id}>{session.label} · {session.parameter} · {new Date(session.created_at).toLocaleDateString()}</option>)}</select></label>}
            </div><button aria-expanded={advanced} className="advanced-toggle" type="button" onClick={() => setAdvanced(!advanced)}><Settings2 size={14} /> Quality gates <ChevronDown className={advanced ? 'open' : ''} size={14} /></button>
            {advanced && <div className="gate-grid">{comparisonMode === 'ensemble' && <GateInput label="Valid peers ≥" value={minimumPeerCount} onChange={setMinimumPeerCount} />}<GateInput label="Completeness ≥" value={gates.completeness} suffix="%" onChange={(value) => setGates({ ...gates, completeness: value })} /><GateInput label="CCC ≥" value={gates.ccc} step="0.01" onChange={(value) => setGates({ ...gates, ccc: value })} />{scaleType === 'ratio' ? <><GateInput label="NRMSE ≤" value={gates.nrmse ?? 20} suffix="%" onChange={(value) => setGates({ ...gates, nrmse: value })} /><GateInput label="Relative bias ≤" value={gates.relative_bias ?? 10} suffix="%" onChange={(value) => setGates({ ...gates, relative_bias: value })} /></> : <OptionalGateInput label="Absolute RMSE ≤" value={gates.absolute_rmse} unit={unit} onChange={(value) => setGates({ ...gates, absolute_rmse: value })} />}<GateInput label="Slope min" value={gates.slope_min} step="0.01" onChange={(value) => setGates({ ...gates, slope_min: value })} /><GateInput label="Slope max" value={gates.slope_max} step="0.01" onChange={(value) => setGates({ ...gates, slope_max: value })} /></div>}
          </section>
        </div>
        <aside className="study-sidebar">
          <section className="collocation-panel study-card run-card">
            <div className="panel-heading"><div><span>Step 3</span><h2>Review & run</h2><p>Your setup stays here when you switch pages.</p></div></div>
            <div className="readiness-checks">
              <div className={authorityReady ? 'done' : ''}><span>{authorityReady ? <Check size={11} /> : completeFiles.length}</span><p><strong>{comparisonMode === 'ensemble' ? `${Math.max(3, minimumPeerCount + 1)} or more sensors` : 'One reference and sensor'}</strong><small>{comparisonMode === 'ensemble' ? `At least ${minimumPeerCount} peers must be valid per comparison` : `${referenceCount} reference · ${targetCount} sensors`}</small></p></div>
              <div className={completeFiles.length === files.length && files.length > 0 ? 'done' : ''}><span>{completeFiles.length === files.length && files.length > 0 ? <Check size={11} /> : completeFiles.length}</span><p><strong>Mappings complete</strong><small>{files.length ? `${completeFiles.length} of ${files.length} ready` : 'Waiting for files'}</small></p></div>
              <div className={parameter.trim() ? 'done' : ''}><span>{parameter.trim() ? <Check size={11} /> : '–'}</span><p><strong>Parameter defined</strong><small>{mappedMeasurementNames > 1 ? 'Different source columns mapped' : 'One shared analysis parameter'}</small></p></div>
            </div>
            <button className="run-collocation" type="button" disabled={!ready} onClick={() => run(false)}>{running ? <><LoaderCircle className="spin" size={16} /> Running analysis…</> : <><CircleGauge size={16} /> Run collocation analysis <ArrowRight size={15} /></>}</button>
            {!ready && <p className="run-help" role="status">{running ? 'Analyzing uploaded observations. This may take a moment.' : runReason}</p>}
          </section>
          <section className="method-card"><Sparkles size={15} /><div><strong>Designed for any sensor</strong><p>PM, gases, CO₂, VOCs, meteorology, noise, radiation, or any shared numeric response.</p></div></section>
        </aside>
      </fieldset>
      {alignmentReview && <div className="modal-backdrop alignment-backdrop" role="presentation"><section ref={alignmentDialog} tabIndex={-1} className="alignment-review" role="dialog" aria-modal="true" aria-labelledby="alignment-review-title"><header><span><Clock3 size={18} /></span><div><small>Review required</small><h2 id="alignment-review-title">Confirm clock alignment</h2><p>Axiom detected possible clock offsets from changes in the shared fleet signal. No timestamp has been altered.</p></div></header><div className="alignment-review-list">{alignmentReview.alignments.map((item) => <div key={item.sensor}><strong>{item.sensor}</strong><span className={item.suggested_lag_minutes ? 'shifted' : ''}>{item.suggested_lag_minutes === 0 ? 'No shift' : `${item.suggested_lag_minutes > 0 ? '+' : ''}${item.suggested_lag_minutes} min`}</span><small>evidence r = {item.correlation?.toFixed(3) ?? '—'}</small></div>)}</div><div className="alignment-explanation"><Info size={14} /><p>Approve only when the suggested offsets are plausible for the device clocks. Applied shifts are analytical metadata; raw timestamps remain unchanged.</p></div><footer><button className="button secondary" type="button" disabled={running} onClick={() => setAlignmentReview(null)}>Back to setup</button><button className="button secondary" type="button" disabled={running} onClick={() => acceptResult(alignmentReview)}>Keep original timestamps</button><button className="button primary" type="button" disabled={running} onClick={() => run(true)}>{running ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Approve suggested shifts</button></footer></section></div>}
    </div>
  )
}

export default CollocationWorkspace

function GateInput({ label, value, suffix, step = '1', onChange }: { label: string; value: number; suffix?: string; step?: string; onChange: (value: number) => void }) {
  return <label><span>{label}</span><div><input type="number" step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />{suffix && <em>{suffix}</em>}</div></label>
}

function OptionalGateInput({ label, value, unit, onChange }: { label: string; value: number | null; unit: string; onChange: (value: number | null) => void }) {
  return <label><span>{label}</span><div><input type="number" value={value ?? ''} placeholder="Off" onChange={(event) => onChange(event.target.value === '' ? null : Number(event.target.value))} />{unit && <em>{unit}</em>}</div></label>
}

function SensorMapping({ file, index, comparisonMode, onRole, onChange, onSheet, onRemove }: { file: SensorFile; index: number; comparisonMode: 'ensemble' | 'reference'; onRole: (role: 'sensor' | 'reference') => void; onChange: (change: Partial<SensorFile>) => void; onSheet: (sheet: string) => void; onRemove: () => void }) {
  const columns = file.inspection.columns
  const numeric = columns.filter((column) => column.type === 'number')
  return <article className="sensor-map-card">
    <header><span className="sensor-index">{String(index + 1).padStart(2, '0')}</span><span className="file-icon"><FileSpreadsheet size={16} /></span><div><strong>{file.inspection.filename}</strong><small>{columns.length} columns · {file.inspection.sample_rows} rows sampled</small></div>{comparisonMode === 'reference' && <select className={`sensor-role-select ${file.role}`} value={file.role} onChange={(event) => onRole(event.target.value as 'sensor' | 'reference')} aria-label={`${file.sensorName} study role`}><option value="sensor">Sensor</option><option value="reference">Reference</option></select>}<span className={file.dateColumn && file.measurementColumn ? 'mapping-status ready' : 'mapping-status'}>{file.dateColumn && file.measurementColumn ? 'Mapped' : 'Needs mapping'}</span><button type="button" onClick={onRemove} aria-label={`Remove ${file.inspection.filename}`}><Trash2 size={14} /></button></header>
    <div className="mapping-fields">
      <label><span>Sensor name</span><input value={file.sensorName} onChange={(event) => onChange({ sensorName: event.target.value })} /></label>
      {file.inspection.sheets.length > 0 && <label><span>Worksheet</span><select value={file.inspection.selected_sheet ?? ''} onChange={(event) => onSheet(event.target.value)}>{file.inspection.sheets.map((sheet) => <option key={sheet}>{sheet}</option>)}</select></label>}
      <label><span>Timestamp column</span><select value={file.dateColumn} onChange={(event) => onChange({ dateColumn: event.target.value })}><option value="">Select column…</option>{columns.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.type}</option>)}</select></label>
      <label><span>Date order</span><select value={file.dayFirst ? 'day' : 'month'} onChange={event => onChange({ dayFirst: event.target.value === 'day' })}><option value="day">Day first (DD/MM/YYYY)</option><option value="month">Month first (MM/DD/YYYY)</option></select></label>
      <label><span>Separate time <em>Optional</em></span><select value={file.timeColumn} onChange={(event) => onChange({ timeColumn: event.target.value })}><option value="">Already included / none</option>{columns.filter((column) => column.name !== file.dateColumn).map((column) => <option key={column.name}>{column.name}</option>)}</select></label>
      <label className="measurement-select"><span>Measurement column · source unit</span><div className="measurement-control"><select value={file.measurementColumn} onChange={(event) => onChange({ measurementColumn: event.target.value })}><option value="">Select numeric column…</option>{numeric.map((column) => <option key={column.name} value={column.name}>{column.name} · {column.sample.slice(0, 2).join(', ')}</option>)}</select><input value={file.sourceUnit} onChange={(event) => onChange({ sourceUnit: event.target.value })} placeholder="same" aria-label={`${file.sensorName} source unit`} /></div></label>
      <details><summary>Environmental covariates <ChevronDown size={12} /></summary><div><label><span>Temperature</span><select value={file.temperatureColumn} onChange={(event) => onChange({ temperatureColumn: event.target.value })}><option value="">Not mapped</option>{numeric.filter((column) => column.name !== file.measurementColumn).map((column) => <option key={column.name}>{column.name}</option>)}</select></label><label><span>Humidity</span><select value={file.humidityColumn} onChange={(event) => onChange({ humidityColumn: event.target.value })}><option value="">Not mapped</option>{numeric.filter((column) => column.name !== file.measurementColumn).map((column) => <option key={column.name}>{column.name}</option>)}</select></label></div></details>
    </div>
  </article>
}

function SensorTable({ result, detailed = false }: { result: CollocationResult; detailed?: boolean }) {
  return <div className="table-wrap"><table className="sensor-score-table"><thead><tr><th>Sensor</th><th>Status</th><th>Completeness</th><th>CCC</th><th>Bias {result.study.unit && `(${result.study.unit})`}</th><th>Relative bias</th><th>NRMSE</th><th>Slope</th>{detailed && <><th>95% agreement limits</th><th>Pearson r</th><th>Spearman ρ</th><th>R²</th><th>Residual trend/day</th><th>Residual vs temp</th><th>Residual vs RH</th><th>Paired / expected</th></>}</tr></thead><tbody>{result.sensors.map((sensor) => <tr key={sensor.sensor}><td><strong>{sensor.sensor}</strong><small>{sensor.benchmark}</small></td><td><span className={`decision-chip ${sensor.status.toLowerCase()}`}>{sensor.status}</span></td><td>{sensor.completeness.toFixed(1)}%</td><td>{sensor.ccc?.toFixed(3) ?? '—'}</td><td><strong className="cell-value">{sensor.bias?.toFixed(3) ?? '—'}</strong>{sensor.bias_ci_low != null && <small>95% CI {sensor.bias_ci_low.toFixed(3)} to {sensor.bias_ci_high?.toFixed(3)}</small>}</td><td title={sensor.relative_metrics_reason}>{sensor.relative_bias == null ? <span className="na-value">Not applicable</span> : <><strong className="cell-value">{sensor.relative_bias > 0 ? '+' : ''}{sensor.relative_bias.toFixed(1)}%</strong>{sensor.relative_bias_ci_low != null && <small>95% CI {sensor.relative_bias_ci_low.toFixed(1)} to {sensor.relative_bias_ci_high?.toFixed(1)}%</small>}</>}</td><td title={sensor.relative_metrics_reason}>{sensor.nrmse == null ? <span className="na-value">N/A</span> : `${sensor.nrmse.toFixed(1)}%`}</td><td>{sensor.slope?.toFixed(3) ?? '—'}</td>{detailed && <><td><strong className="cell-value">{sensor.agreement_limit_low?.toFixed(2) ?? '—'} to {sensor.agreement_limit_high?.toFixed(2) ?? '—'}</strong>{sensor.agreement_limit_low_ci?.[0] != null && <small>Lower-limit CI {sensor.agreement_limit_low_ci[0]?.toFixed(2)} to {sensor.agreement_limit_low_ci[1]?.toFixed(2)}<br />Upper-limit CI {sensor.agreement_limit_high_ci[0]?.toFixed(2)} to {sensor.agreement_limit_high_ci[1]?.toFixed(2)}</small>}</td><td>{sensor.pearson?.toFixed(3) ?? '—'}</td><td>{sensor.spearman?.toFixed(3) ?? '—'}</td><td>{sensor.r_squared?.toFixed(3) ?? '—'}</td><td>{sensor.residual_trend_per_day?.toFixed(3) ?? '—'}{sensor.residual_trend_p_value != null && <small>p = {sensor.residual_trend_p_value.toFixed(3)}</small>}</td><td>{sensor.temperature_residual_correlation?.toFixed(3) ?? 'Not mapped'}</td><td>{sensor.humidity_residual_correlation?.toFixed(3) ?? 'Not mapped'}</td><td>{sensor.paired_bins.toLocaleString()} / {sensor.eligible_bins.toLocaleString()}<small>{sensor.duration_hours?.toFixed(1)} h · block {sensor.bootstrap_block_length ?? '—'}</small></td></>}</tr>)}</tbody></table></div>
}

function RangeBias({ result }: { result: CollocationResult }) {
  return <div className="range-bias-grid">{result.sensors.map((sensor) => <article key={sensor.sensor}><header><div><strong>{sensor.sensor}</strong><small>{sensor.benchmark}</small></div><span>{sensor.range_bias?.length ? `${sensor.range_bias.length} ${sensor.range_bias.length === 1 ? 'stratum' : 'strata'}` : 'Insufficient data'}</span></header>{sensor.range_bias?.length ? <table><thead><tr><th>Range</th><th>Benchmark span</th><th>Bias</th><th>{sensor.relative_metrics_applicable ? 'Relative' : 'RMSE'}</th><th>n</th></tr></thead><tbody>{sensor.range_bias.map((range) => <tr key={range.range}><td><strong>{range.range}</strong></td><td>{range.minimum?.toFixed(2)}–{range.maximum?.toFixed(2)}</td><td>{range.bias?.toFixed(3) ?? '—'}</td><td>{sensor.relative_metrics_applicable ? range.relative_bias == null ? '—' : `${range.relative_bias.toFixed(1)}%` : range.rmse?.toFixed(3) ?? '—'}</td><td>{range.paired_bins}</td></tr>)}</tbody></table> : <p>At least nine paired observations are required for range-stratified bias.</p>}</article>)}</div>
}
