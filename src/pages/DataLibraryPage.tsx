import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Database, FileUp, HardDrive, RefreshCw, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useDevices } from '../hooks/useData'
import { devices as mockDevices } from '../mocks/data'
import { useWorkspaceTable, workspaceRpc } from '../hooks/useWorkspaceTable'
import { CsvMinuteAggregator } from '../../supabase/functions/_shared/csv-minute-history'
import { csvFileWindow } from '../../supabase/functions/_shared/csv-file-window'
import { demoMode, supabase } from '../services/supabase'
import { formatFileSize } from '../utils'
import { uploadCsvChunks } from '../utils/csvChunks'

interface ImportRun {
  id: string
  device_id: string
  filename: string
  status: string
  created_at: string
  imported_minutes: number
  skipped_rows: number
  source_bytes: number
  error_message: string | null
}
interface StorageDevice {
  device_id: string
  device_code: string
  minute_points: number
  oldest_minute: string | null
  latest_minute: string | null
  days: number | null
}
interface StorageSummary {
  database_bytes: number
  minute_table_bytes: number
  snapshot_table_bytes: number
  devices: StorageDevice[]
}
interface RetentionPreview {
  deviceId: string
  days: number | null
  affected: number
}
const formatTime = (value: string) =>
  new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) +
  ' IST'

export function DataLibraryPage() {
  const fleet = useDevices()
  const imports = useWorkspaceTable<ImportRun>('csv_import_runs', 'created_at')
  const [tab, setTab] = useState<'import' | 'storage'>('import')
  const [deviceId, setDeviceId] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<{
    rows: number
    minutes: number
    skipped: number
    first: string | null
    last: string | null
  } | null>(null)
  const [previewBusy, setPreviewBusy] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [retentionDays, setRetentionDays] = useState('')
  const [retentionPreview, setRetentionPreview] = useState<RetentionPreview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const device = fleet.data.find((d) => d.id === deviceId)
  useEffect(() => {
    const first = fleet.data[0]?.id
    if (first) setDeviceId((id) => id || first)
  }, [fleet.data])
  const loadStorage = useCallback(async () => {
    setStorageLoading(true)
    try {
      if (demoMode) {
        const devices: StorageDevice[] = mockDevices.map((d) => ({
          device_id: d.id,
          device_code: d.code,
          minute_points: 1360,
          oldest_minute: new Date(Date.now() - 3 * 86400000).toISOString(),
          latest_minute: new Date().toISOString(),
          days: null,
        }))
        setSummary({
          database_bytes: 24_000_000,
          minute_table_bytes: 7_200_000,
          snapshot_table_bytes: 2_400_000,
          devices,
        })
      } else setSummary((await workspaceRpc('history_storage_summary')) as StorageSummary)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Storage usage could not be loaded.')
    } finally {
      setStorageLoading(false)
    }
  }, [])
  useEffect(() => {
    if (tab === 'storage' && fleet.data.length) void loadStorage()
  }, [tab, fleet.data.length, loadStorage])
  useEffect(() => {
    setPreview(null)
    setRetentionPreview(null)
    setConfirmed(false)
    setFailure('')
  }, [deviceId, file])
  const selectedStorage = summary?.devices.find((d) => d.device_id === deviceId)
  const totalPoints = useMemo(
    () => summary?.devices.reduce((sum, d) => sum + Number(d.minute_points), 0) ?? 0,
    [summary],
  )

  const inspect = async () => {
    if (!file || !device) return
    setPreviewBusy(true)
    setFailure('')
    setPreview(null)
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('Maximum import size is 100 MiB.')
      const { from, until } = csvFileWindow(file.name, device.code)
      const parser = new CsvMinuteAggregator(from, until, device.co2Enabled)
      const head = await file.slice(0, Math.min(file.size, 1024 * 1024)).text()
      parser.push(head)
      const points = parser.finish()
      if (!points.length)
        throw new Error('No verified readings were found in the first MiB. Check the logger and file.')
      setPreview({
        rows: parser.parsedRows,
        minutes: points.length,
        skipped: parser.skippedRows,
        first: points[0].timestamp,
        last: points.at(-1)!.timestamp,
      })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not inspect the CSV.')
    } finally {
      setPreviewBusy(false)
    }
  }
  const upload = async () => {
    if (!file || !device || !preview || busy) return
    setBusy(true)
    setProgress(0)
    setMessage('')
    setFailure('')
    try {
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 450))
        setProgress(100)
        setMessage('Demo preview complete. No data was uploaded.')
      } else {
        const session = await supabase!.auth.getSession()
        if (!session.data.session?.access_token) throw new Error('Your session has expired. Sign in again.')
        const endpoint = `${new URL(import.meta.env.VITE_SUPABASE_URL!).origin}/functions/v1/import-history`
        const post = async (params: Record<string, string>, body?: string) => {
          const query = new URLSearchParams(params)
          const response = await fetch(`${endpoint}?${query}`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${session.data.session!.access_token}`,
              apikey: import.meta.env.VITE_SUPABASE_ANON_KEY!,
              'Content-Type': body === undefined ? 'application/json' : 'text/csv',
            },
            body: body ?? '{}',
          })
          const result = (await response.json().catch(() => ({}))) as {
            error?: string
            run_id?: string
            minutes?: number
            skipped?: number
          }
          if (!response.ok) throw new Error(result.error ?? `Import request failed (HTTP ${response.status}).`)
          return result
        }
        const started = await post({
          action: 'start',
          device_id: device.id,
          filename: file.name,
          bytes: String(file.size),
        })
        if (!started.run_id) throw new Error('Import service did not start a session.')
        await uploadCsvChunks(
          file,
          async (index, body, originalBytes) => {
            await post(
              { action: 'chunk', run_id: started.run_id!, index: String(index), original_bytes: String(originalBytes) },
              body,
            )
          },
          (fraction) => setProgress(Math.round(fraction * 100)),
        )
        const result = await post({ action: 'finish', run_id: started.run_id })
        setMessage(
          `Imported ${(result.minutes ?? 0).toLocaleString()} one-minute averages. ${(result.skipped ?? 0).toLocaleString()} incomplete or invalid rows skipped.`,
        )
        imports.reload()
        setFile(null)
        setPreview(null)
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Import failed. Retry the same file.')
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }
  const previewRetention = async () => {
    if (!device) return
    setBusy(true)
    setFailure('')
    setRetentionPreview(null)
    setConfirmed(false)
    try {
      const days = retentionDays === '' ? null : Number(retentionDays)
      if (days !== null && (!Number.isInteger(days) || days < 7 || days > 3650))
        throw new Error('Choose 7–3650 days, or leave blank to disable retention.')
      const affected = demoMode
        ? days === null
          ? 0
          : 120
        : Number(await workspaceRpc('preview_history_retention', { p_device: device.id, p_days: days }))
      setRetentionPreview({ deviceId: device.id, days, affected })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Retention preview failed.')
    } finally {
      setBusy(false)
    }
  }
  const applyRetention = async () => {
    if (!retentionPreview || !confirmed || retentionPreview.deviceId !== deviceId) return
    setBusy(true)
    setFailure('')
    setMessage('')
    try {
      if (!demoMode)
        await workspaceRpc('set_history_retention', {
          p_device: deviceId,
          p_days: retentionPreview.days,
          p_confirm: true,
        })
      setMessage(
        retentionPreview.days === null
          ? 'Automatic retention disabled for this logger.'
          : `Retention saved: ${retentionPreview.days} days. Old points will be removed in small batches after the next hourly maintenance run.`,
      )
      setRetentionPreview(null)
      setConfirmed(false)
      await loadStorage()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not save retention.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page library-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Source data & storage</span>
          <h1>Data library</h1>
          <p>Bring older SD files into your history and manage the data retained in the cloud.</p>
        </div>
        <Link className="button secondary" to="/files">
          <Database size={16} />
          Browse logger files
        </Link>
      </section>
      <nav className="research-tabs" aria-label="Data library views">
        <button aria-pressed={tab === 'import'} onClick={() => setTab('import')}>
          <FileUp size={17} />
          Historical import
        </button>
        <button aria-pressed={tab === 'storage'} onClick={() => setTab('storage')}>
          <HardDrive size={17} />
          Storage & retention
        </button>
      </nav>
      {message && (
        <div className="success-banner" role="status">
          <CheckCircle2 size={16} />
          {message}
        </div>
      )}
      {(failure || fleet.error || imports.error) && (
        <div className="error-banner" role="alert">
          {failure || fleet.error || imports.error}
        </div>
      )}
      {tab === 'import' && (
        <>
          <div className="library-grid">
            <section className="panel library-card">
              <span className="eyebrow">Historical readings</span>
              <h2>Import an SD CSV</h2>
              <p>
                Choose the logger that created this file. Preview its date and sensor columns before importing
                one-minute averages.
              </p>
              <label>
                Logger
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  {fleet.data.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} · {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                CSV file
                <input
                  aria-label="Choose historical CSV"
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
              </label>
              {file && (
                <div className="library-file-summary">
                  <strong>{file.name}</strong>
                  <span>
                    {formatFileSize(file.size)} · {device?.code ?? 'Select logger'}
                  </span>
                </div>
              )}
              <button
                className="button secondary"
                disabled={!file || !device || previewBusy || busy}
                onClick={() => void inspect()}
              >
                <ShieldCheck size={16} />
                {previewBusy ? 'Inspecting…' : 'Preview CSV'}
              </button>
              {preview && (
                <div className="library-preview">
                  <strong>Preview of first 1 MiB</strong>
                  <dl>
                    <div>
                      <dt>Verified samples</dt>
                      <dd>{preview.rows.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>One-minute points</dt>
                      <dd>{preview.minutes.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>First reading</dt>
                      <dd>{preview.first ? formatTime(preview.first) : '—'}</dd>
                    </div>
                    <div>
                      <dt>Last reading</dt>
                      <dd>{preview.last ? formatTime(preview.last) : '—'}</dd>
                    </div>
                    <div>
                      <dt>Skipped preview rows</dt>
                      <dd>{preview.skipped.toLocaleString()}</dd>
                    </div>
                  </dl>
                  <small>
                    The whole file is checked again during import. Existing minutes are updated only when the CSV has
                    more samples for that minute.
                  </small>
                </div>
              )}
              {progress !== null && (
                <div className="library-progress" role="status">
                  <span>Uploading CSV</span>
                  <strong>{progress}%</strong>
                  <progress value={progress} max={100} />
                </div>
              )}
              <button className="button primary" disabled={!preview || !device || busy} onClick={() => void upload()}>
                <FileUp size={16} />
                {busy ? 'Importing…' : 'Import averages'}
              </button>
              <p className="research-source-note">
                Files must have verified Date and Time columns and match the selected logger’s dated filename. Unsynced
                recovery files are excluded. Raw CSV bytes are not kept after import.
              </p>
            </section>
            <section className="panel library-card">
              <span className="eyebrow">Provenance</span>
              <h2>Recent imports</h2>
              {imports.loading ? (
                <p role="status">Loading import history…</p>
              ) : !imports.data.length ? (
                <div className="empty compact">
                  <FileUp size={28} />
                  <h3>No manual imports yet</h3>
                  <p>Your first verified SD CSV will appear here.</p>
                </div>
              ) : (
                imports.data.slice(0, 30).map((run) => (
                  <article className="library-import-run" key={run.id}>
                    <div>
                      <strong>{run.filename}</strong>
                      <small>
                        {fleet.data.find((d) => d.id === run.device_id)?.code ?? 'Unknown logger'} ·{' '}
                        {formatTime(run.created_at)}
                      </small>
                    </div>
                    <span className={`operation-status ${run.status}`}>{run.status}</span>
                    <small>
                      {run.status === 'completed'
                        ? `${run.imported_minutes.toLocaleString()} minute points · ${formatFileSize(run.source_bytes)}`
                        : (run.error_message ?? 'In progress')}
                    </small>
                  </article>
                ))
              )}
            </section>
          </div>
        </>
      )}
      {tab === 'storage' && (
        <>
          <div className="research-summary">
            <div>
              <span>Cloud database</span>
              <strong>{summary ? formatFileSize(summary.database_bytes) : '—'}</strong>
            </div>
            <div>
              <span>Minute history table</span>
              <strong>{summary ? formatFileSize(summary.minute_table_bytes) : '—'}</strong>
            </div>
            <div>
              <span>Live snapshot table</span>
              <strong>{summary ? formatFileSize(summary.snapshot_table_bytes) : '—'}</strong>
            </div>
            <div>
              <span>Minute points</span>
              <strong>{totalPoints.toLocaleString()}</strong>
            </div>
          </div>
          <div className="library-grid">
            <section className="panel library-card">
              <div className="section-head">
                <div>
                  <span className="eyebrow">Cloud footprint</span>
                  <h2>Per-logger storage</h2>
                </div>
                <button className="button secondary small" onClick={() => void loadStorage()} disabled={storageLoading}>
                  <RefreshCw size={15} />
                  Refresh
                </button>
              </div>
              {storageLoading && <p role="status">Calculating storage usage…</p>}
              <div className="table-scroll">
                <table className="research-table">
                  <thead>
                    <tr>
                      <th>Logger</th>
                      <th>Minute points</th>
                      <th>Oldest</th>
                      <th>Policy</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary?.devices.map((row) => (
                      <tr key={row.device_id}>
                        <th scope="row">{row.device_code}</th>
                        <td>{Number(row.minute_points).toLocaleString()}</td>
                        <td>{row.oldest_minute ? formatTime(row.oldest_minute) : '—'}</td>
                        <td>{row.days === null ? 'Keep until changed' : `${row.days} days`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="research-source-note">
                Database sizes include indexes and internal overhead. They may not shrink immediately after deletion.
                Temporary transfer files are managed separately.
              </p>
            </section>
            <section className="panel library-card">
              <span className="eyebrow">Opt-in policy</span>
              <h2>Minute-history retention</h2>
              <p>
                Choose how long cloud minute points are kept for one logger. This does not delete five-minute snapshots,
                manual SD files, or files on the logger.
              </p>
              <label>
                Logger
                <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
                  {fleet.data.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.code} · {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="library-current-policy">
                Current policy:{' '}
                <strong>
                  {selectedStorage?.days == null ? 'No automatic deletion' : `${selectedStorage.days} days`}
                </strong>
              </p>
              <label>
                Keep minute points for · days
                <input
                  type="number"
                  min={7}
                  max={3650}
                  placeholder="Blank = no automatic deletion"
                  value={retentionDays}
                  onChange={(e) => {
                    setRetentionDays(e.target.value)
                    setRetentionPreview(null)
                    setConfirmed(false)
                  }}
                />
              </label>
              <button className="button secondary" disabled={busy || !deviceId} onClick={() => void previewRetention()}>
                <ShieldCheck size={16} />
                Preview impact
              </button>
              {retentionPreview && (
                <div className="library-preview">
                  <strong>
                    {retentionPreview.days === null
                      ? 'Disable automatic deletion'
                      : `Keep the latest ${retentionPreview.days} days`}
                  </strong>
                  <p>
                    {retentionPreview.affected.toLocaleString()} existing minute points would qualify for deletion as of
                    now. Deletion runs hourly in batches of up to 5,000 points per logger.
                  </p>
                  <label className="library-confirm">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I
                    understand the cloud minute points older than this policy will be permanently removed.
                  </label>
                  <button
                    className="button primary"
                    disabled={!confirmed || busy}
                    onClick={() => void applyRetention()}
                  >
                    Save retention policy
                  </button>
                </div>
              )}
              <p className="research-source-note">
                The default is unlimited retention. Policies apply only after this confirmation and are recorded in an
                audit log.
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
