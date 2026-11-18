import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  Check,
  CheckCircle2,
  FileSpreadsheet,
  LoaderCircle,
  TableProperties,
  UploadCloud,
  X,
} from 'lucide-react'
import { commitImport, inspectSheet, inspectUpload } from '../api'
import type { ImportedDataset, ImportInspection } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  onImported: (dataset: ImportedDataset) => void | Promise<void>
}

interface MeasurementChoice {
  column: string
  label: string
  unit: string
}

const ACCEPTED = '.csv,.tsv,.txt,.json,.xlsx,.xls'

function filenameWithoutExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export function ImportDatasetDialog({ open, onClose, onImported }: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const loadingRef = useRef(false)
  const [inspection, setInspection] = useState<ImportInspection | null>(null)
  const [datasetName, setDatasetName] = useState('')
  const [dateColumn, setDateColumn] = useState('')
  const [timeColumn, setTimeColumn] = useState('')
  const [dayFirst, setDayFirst] = useState(true)
  const [measurements, setMeasurements] = useState<MeasurementChoice[]>([])
  const [loading, setLoading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [imported, setImported] = useState<ImportedDataset | null>(null)
  loadingRef.current = loading

  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !loadingRef.current) closeRef.current()
      if (event.key === 'Tab') {
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled):not([hidden]), select:not(:disabled), [tabindex="0"]') ?? []).filter(item => item.getClientRects().length > 0)
        const first = items[0]
        const last = items.at(-1)
        if (!first) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previousFocus?.focus()
    }
  }, [open])

  if (!open) return null

  const applyInspection = (next: ImportInspection, preserveFile = false) => {
    const merged = preserveFile && inspection
      ? { ...next, filename: inspection.filename, size: inspection.size }
      : next
    setInspection(merged)
    setDateColumn(next.suggestions.date_column ?? '')
    setTimeColumn(next.suggestions.time_column ?? '')
    setMeasurements(
      next.suggestions.measurements.map((column) => ({ column, label: column, unit: '' })),
    )
  }

  const reset = () => {
    setInspection(null)
    setDatasetName('')
    setDateColumn('')
    setTimeColumn('')
    setMeasurements([])
    setError(null)
    setImported(null)
  }

  const loadFile = async (file?: File) => {
    if (!file || loading) return
    setLoading(true)
    setError(null)
    setImported(null)
    try {
      const result = await inspectUpload(file)
      applyInspection(result)
      setDatasetName(filenameWithoutExtension(file.name))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The file could not be inspected')
    } finally {
      setLoading(false)
    }
  }

  const changeSheet = async (sheet: string) => {
    if (!inspection) return
    setLoading(true)
    setError(null)
    try {
      const result = await inspectSheet(inspection.upload_id, sheet)
      applyInspection(result, true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The worksheet could not be inspected')
    } finally {
      setLoading(false)
    }
  }

  const toggleMeasurement = (column: string) => {
    const existing = measurements.find((item) => item.column === column)
    if (existing) {
      setMeasurements(measurements.filter((item) => item.column !== column))
    } else {
      setMeasurements([...measurements, { column, label: column, unit: '' }])
    }
  }

  const updateMeasurement = (column: string, field: 'label' | 'unit', value: string) => {
    setMeasurements(measurements.map((item) => (
      item.column === column ? { ...item, [field]: value } : item
    )))
  }

  const submit = async () => {
    if (!inspection || !datasetName.trim() || loading) return
    setLoading(true)
    setError(null)
    try {
      const result = await commitImport({
        upload_id: inspection.upload_id,
        dataset_name: datasetName.trim(),
        source_filename: inspection.filename,
        sheet: inspection.selected_sheet,
        date_column: dateColumn || null,
        time_column: dateColumn && timeColumn ? timeColumn : null,
        day_first: dayFirst,
        measurements,
      })
      setImported(result.dataset)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The dataset could not be imported')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !loading) onClose()
    }}>
      <section ref={dialogRef} tabIndex={-1} className="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <header className="import-header">
          <div>
            <span className="modal-kicker">Data source</span>
            <h2 id="import-title">{imported ? 'Dataset ready' : inspection ? 'Configure your data' : 'Import a dataset'}</h2>
            <p>{imported
              ? 'Your data is normalized and ready to explore.'
              : inspection
                ? 'Tell Axiom how time and measurements are represented.'
                : 'Upload a spreadsheet or delimited text file to begin.'}</p>
          </div>
          <button className="icon-button" type="button" onClick={onClose} disabled={loading} aria-label="Close import dialog"><X size={18} /></button>
        </header>

        {error && <div className="import-error" role="alert"><AlertCircle size={15} />{error}</div>}

        {imported ? (
          <div className="import-success">
            <span className="success-icon"><CheckCircle2 size={29} /></span>
            <h3>{imported.name}</h3>
            <p>{imported.rows.toLocaleString()} rows and {imported.columns?.length ?? 0} columns are ready for analysis.</p>
            <div className="success-summary">
              <div><span>Time range</span><strong>{imported.start && imported.end ? `${new Date(imported.start).toLocaleDateString()} – ${new Date(imported.end).toLocaleDateString()}` : 'Not configured'}</strong></div>
              <div><span>Excluded rows</span><strong>{imported.invalid_rows.toLocaleString()}</strong></div>
            </div>
            <button className="button primary success-action" type="button" disabled={loading} onClick={async () => { setLoading(true); setError(null); try { await onImported(imported); reset(); onClose() } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not refresh the workspace. Try again.') } finally { setLoading(false) } }}>
              {loading ? 'Opening…' : 'Explore dataset'}
            </button>
          </div>
        ) : !inspection ? (
          <div className="upload-stage">
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED}
              hidden
              onChange={(event) => loadFile(event.target.files?.[0])}
            />
            <button
              className={`drop-zone ${dragging ? 'dragging' : ''}`}
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragEnter={(event) => { event.preventDefault(); setDragging(true) }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault()
                setDragging(false)
                loadFile(event.dataTransfer.files[0])
              }}
              disabled={loading}
            >
              <span className="drop-icon">{loading ? <LoaderCircle className="spin" size={25} /> : <UploadCloud size={25} />}</span>
              <strong>{loading ? 'Reading columns…' : 'Drop a file here'}</strong>
              <span>{loading ? 'This can take a moment for larger files.' : 'or click to browse your computer'}</span>
              {!loading && <small>CSV, TSV, TXT, JSON, XLSX or XLS · up to 100 MB</small>}
            </button>
            <div className="upload-notes">
              <div><TableProperties size={16} /><span><strong>Automatic schema detection</strong><small>Column names, types, examples, and worksheets</small></span></div>
              <div><FileSpreadsheet size={16} /><span><strong>Your source stays unchanged</strong><small>A normalized working copy is created locally</small></span></div>
            </div>
          </div>
        ) : (
          <div className="mapping-stage">
            <div className="file-summary">
              <span className="file-type-icon"><FileSpreadsheet size={18} /></span>
              <div><strong>{inspection.filename}</strong><span>{formatBytes(inspection.size)} · {inspection.columns.length} columns detected</span></div>
              <button type="button" disabled={loading} onClick={reset}><ArrowLeft size={13} /> Replace</button>
            </div>

            <fieldset disabled={loading} className="mapping-scroll mapping-fieldset">
              <div className="mapping-section two-column-fields">
                <label className="field">
                  <span>Dataset name</span>
                  <input className="control" value={datasetName} onChange={(event) => setDatasetName(event.target.value)} placeholder="e.g. Boardroom sensor" />
                </label>
                {inspection.sheets.length > 0 && (
                  <label className="field">
                    <span>Worksheet</span>
                    <select className="control" value={inspection.selected_sheet ?? ''} onChange={(event) => changeSheet(event.target.value)}>
                      {inspection.sheets.map((sheet) => <option key={sheet} value={sheet}>{sheet}</option>)}
                    </select>
                  </label>
                )}
              </div>

              <div className="mapping-section">
                <div className="section-title"><span>1</span><div><strong>Define time</strong><small>Choose one timestamp column, or separate date and time columns.</small></div></div>
                <div className="two-column-fields inset-fields">
                  <label className="field">
                    <span>Date or timestamp column</span>
                    <select className="control" value={dateColumn} onChange={(event) => { const next = event.target.value; setDateColumn(next); setTimeColumn(''); setMeasurements(current => current.filter(item => item.column !== next)) }}>
                      <option value="">No time column · statistics only</option>
                      {inspection.columns.map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                    </select>
                  </label>
                  <label className="field">
                    <span>Time column <em>Optional</em></span>
                    <select className="control" value={timeColumn} onChange={(event) => setTimeColumn(event.target.value)} disabled={!dateColumn}>
                      <option value="">Already included / none</option>
                      {inspection.columns.filter((column) => column.name !== dateColumn).map((column) => <option key={column.name} value={column.name}>{column.name}</option>)}
                    </select>
                  </label>
                </div>
                <label className="check-label">
                  <input type="checkbox" checked={dayFirst} onChange={(event) => setDayFirst(event.target.checked)} />
                  <span className="custom-check">{dayFirst && <Check size={11} />}</span>
                  Dates use day-first format <small>(31/12/2026)</small>
                </label>
              </div>

              <div className="mapping-section">
                <div className="section-title"><span>2</span><div><strong>Choose time-series measurements</strong><small>Optional. Every source column remains available for statistical analysis.</small></div><b>{measurements.length} selected</b></div>
                <div className="column-list">
                  {inspection.columns.filter((column) => column.name !== dateColumn && column.name !== timeColumn).map((column) => {
                    const choice = measurements.find((item) => item.column === column.name)
                    return (
                      <div className={`column-row ${choice ? 'selected' : ''}`} key={column.name}>
                        <button className="column-toggle" type="button" disabled={column.type !== 'number'} title={column.type !== 'number' ? 'Available in statistics; time series requires numeric values.' : undefined} onClick={() => toggleMeasurement(column.name)} aria-pressed={Boolean(choice)}>
                          <span className={`checkbox ${choice ? 'checked' : ''}`}>{choice && <Check size={12} />}</span>
                          <span><strong>{column.name}</strong><small>{column.type} · {column.sample.join(', ') || 'No sample values'}</small></span>
                        </button>
                        {choice && (
                          <div className="column-config">
                            <input value={choice.label} onChange={(event) => updateMeasurement(column.name, 'label', event.target.value)} aria-label={`${column.name} display name`} placeholder="Display name" />
                            <input value={choice.unit} onChange={(event) => updateMeasurement(column.name, 'unit', event.target.value)} aria-label={`${column.name} unit`} placeholder="Unit (auto)" />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </fieldset>

            <footer className="import-footer">
              <span>{inspection.sample_rows} sample rows inspected</span>
              <button
                className="button primary"
                type="button"
                onClick={submit}
                disabled={loading || !datasetName.trim()}
              >
                {loading ? <><LoaderCircle className="spin" size={15} /> Importing…</> : 'Import dataset'}
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  )
}
