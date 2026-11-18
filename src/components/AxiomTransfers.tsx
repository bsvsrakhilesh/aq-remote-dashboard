import { useEffect, useState } from 'react'
import { axiomMessages, requestAxiom } from '../services/axiom'
import { useAxiomSend } from '../hooks/useAxiomSend'
import { formatFileSize } from '../utils'
import { istDate } from '../utils/minuteHistory'

interface Job {
  id: string
  filename: string
  kind: 'raw' | 'minute'
  status: 'queued' | 'waiting_logger' | 'transferring' | 'ready' | 'failed'
  source_bytes: number
  row_count: number | null
  error_code: string | null
}

interface QueueStatus {
  jobs: Job[]
  bytes: number
  limit: number
  worker_last_seen: string | null
  paused: boolean
  locked: boolean
}

const labels: Record<Job['status'], string> = {
  queued: 'Queued',
  waiting_logger: 'Waiting for logger',
  transferring: 'Transferring',
  ready: 'Ready to review',
  failed: 'Needs attention',
}

const axiomLink = (job?: string) =>
  `${import.meta.env.BASE_URL}axiom/${job ? `?transfer=${encodeURIComponent(job)}` : ''}`

export function AxiomQueue({ revision }: { revision: number }) {
  const [queue, setQueue] = useState<QueueStatus | null>(null)
  const [error, setError] = useState('')
  const [updating, setUpdating] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    let pending = false
    const load = async () => {
      if (!active || pending || document.visibilityState === 'hidden') return
      pending = true
      try {
        const result = await requestAxiom<QueueStatus>({ action: 'list' })
        if (active) {
          setQueue(result)
          setError('')
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : 'Could not load transfers.')
      } finally {
        pending = false
      }
    }
    void load()
    const timer = window.setInterval(() => void load(), 30_000)
    document.addEventListener('visibilitychange', load)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', load)
    }
  }, [revision, refresh])
  const togglePause = async () => {
    if (!queue || updating) return
    setUpdating(true)
    try {
      await requestAxiom({ action: queue.paused ? 'resume' : 'pause' })
      setRefresh((previous) => previous + 1)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update transfer settings.')
    } finally {
      setUpdating(false)
    }
  }
  const jobs = queue?.jobs ?? []
  const workerOnline = !!queue?.worker_last_seen && Date.now() - Date.parse(queue.worker_last_seen) <= 300_000

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Axiom transfers</h2>
        <div className="controls">
          {queue && !queue.locked && (
            <button
              type="button"
              className="button secondary small"
              disabled={updating}
              onClick={() => void togglePause()}
            >
              {queue.paused ? 'Resume transfers' : 'Pause transfers'}
            </button>
          )}
          <a className="button secondary small" href={axiomLink()}>
            Open Axiom
          </a>
        </div>
      </div>
      {queue && (
        <p>
          {queue.paused || queue.locked
            ? 'Transfers paused'
            : workerOnline
              ? 'Lab worker online'
              : 'Waiting for the lab worker'}
          {' · '}
          {formatFileSize(queue.bytes)} of {formatFileSize(queue.limit)} reserved this month
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!error && !jobs.length && <p>{queue ? 'Files sent to Axiom appear here.' : 'Loading transfers…'}</p>}
      {jobs.length > 0 && (
        <ul className="axiom-job-list">
          {jobs.map((job) => (
            <li key={job.id}>
              <div>
                <strong>{job.filename}</strong>
                <p>
                  {job.kind === 'raw' ? 'SD snapshot' : `${job.row_count?.toLocaleString()} recorded minutes`}
                  {' · '}
                  {formatFileSize(job.source_bytes)}
                </p>
                {job.error_code && axiomMessages[job.error_code] && <p>{axiomMessages[job.error_code]}</p>}
              </div>
              {job.status === 'ready' ? (
                <a className="button secondary small" href={axiomLink(job.id)}>
                  Open in Axiom
                </a>
              ) : (
                <span>{labels[job.status]}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function AxiomMinuteExport({ deviceId, selectedDate }: { deviceId: string; selectedDate: string }) {
  const [from, setFrom] = useState(selectedDate)
  const [through, setThrough] = useState(selectedDate)
  const [preview, setPreview] = useState<{ rows: number; expected: number } | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [checking, setChecking] = useState(false)
  const { busy, failed, notice, revision, send } = useAxiomSend()
  const source = { kind: 'minute', device_id: deviceId, from, through }
  const check = async () => {
    setChecking(true)
    setPreviewError('')
    try {
      setPreview(await requestAxiom({ ...source, action: 'preview' }))
    } catch (reason) {
      setPreviewError(reason instanceof Error ? reason.message : 'Could not check coverage.')
    } finally {
      setChecking(false)
    }
  }
  return (
    <>
      <section className="panel">
        <h2>Send minute history to Axiom</h2>
        <p>Choose up to seven dates in IST for this logger.</p>
        <div className="controls">
          <label>
            From{' '}
            <input
              type="date"
              value={from}
              max={istDate()}
              disabled={checking || busy}
              onChange={(event) => {
                setFrom(event.target.value)
                setPreview(null)
                setPreviewError('')
              }}
            />
          </label>
          <label>
            Through{' '}
            <input
              type="date"
              value={through}
              min={from}
              max={istDate()}
              disabled={checking || busy}
              onChange={(event) => {
                setThrough(event.target.value)
                setPreview(null)
                setPreviewError('')
              }}
            />
          </label>
          <button
            className="button secondary small"
            type="button"
            disabled={!from || !through || checking || busy}
            onClick={() => void check()}
          >
            {checking ? 'Checking…' : 'Check coverage'}
          </button>
          <button
            className="button primary small"
            type="button"
            disabled={!preview?.rows || checking || busy}
            onClick={() => void send(source)}
          >
            Send to Axiom
          </button>
        </div>
        {preview && (
          <p role="status">
            {preview.rows.toLocaleString()} of {preview.expected.toLocaleString()} minutes available.
          </p>
        )}
        {previewError && <p role="alert">{previewError}</p>}
        {notice && <p role={failed ? 'alert' : 'status'}>{notice}</p>}
      </section>
      <AxiomQueue revision={revision} />
    </>
  )
}
