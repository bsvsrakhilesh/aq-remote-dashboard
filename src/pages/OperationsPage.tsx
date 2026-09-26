import { useEffect, useState } from 'react'
import { Bell, Check, CloudDownload, NotebookPen, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useDevices } from '../hooks/useData'
import { useWorkspaceTable, workspaceRpc, workspaceWrite } from '../hooks/useWorkspaceTable'
import { demoMode, supabase } from '../services/supabase'
import { closedSyncWindow } from '../utils/minuteHistory'
import { metrics } from '../utils/research'
import { formatRelative } from '../utils'

export interface AlertEvent {
  id: string
  device_id: string
  metric: string
  message: string
  observed_value: number | null
  opened_at: string
  resolved_at: string | null
  acknowledged_at: string | null
}
interface Rule {
  id: string
  device_id: string
  metric: string
  direction: string
  threshold: number
  duration_minutes: number
  enabled: boolean
}
interface Note {
  id: string
  device_id: string
  kind: string
  location: string
  body: string
  occurred_at: string
}
interface SyncJob {
  id: string
  device_id: string
  status: string
  filename: string
  created_at: string
  completed_at: string | null
  error_message: string | null
  imported_minutes: number | null
}
interface SyncSetting {
  device_id: string
  enabled: boolean
}
const time = (stamp: string) =>
  new Date(stamp).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) +
  ' IST'

export function OperationsPage() {
  const fleet = useDevices()
  const events = useWorkspaceTable<AlertEvent>('alert_events', 'opened_at')
  const rules = useWorkspaceTable<Rule>('alert_rules', 'created_at')
  const notes = useWorkspaceTable<Note>('deployment_notes', 'occurred_at')
  const jobs = useWorkspaceTable<SyncJob>('csv_history_jobs', 'created_at')
  const settings = useWorkspaceTable<SyncSetting>('csv_history_settings', 'device_id')
  const [tab, setTab] = useState<'alerts' | 'notes' | 'sync'>('alerts')
  const [deviceId, setDeviceId] = useState('')
  const [metric, setMetric] = useState('offline')
  const [threshold, setThreshold] = useState(50)
  const [direction, setDirection] = useState('above')
  const [duration, setDuration] = useState(15)
  const [kind, setKind] = useState('observation')
  const [location, setLocation] = useState('')
  const [body, setBody] = useState('')
  const [occurred, setOccurred] = useState(() => new Date(Date.now() + 19800000).toISOString().slice(0, 16))
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(true)
  const first = fleet.data[0]?.id
  useEffect(() => {
    if (first) setDeviceId((d) => d || first)
  }, [first])
  const device = fleet.data.find((d) => d.id === deviceId)
  const code = (id: string) => fleet.data.find((d) => d.id === id)?.code ?? 'Unknown logger'
  const run = async (task: () => Promise<unknown>, success: string) => {
    if (busy) return
    setBusy(true)
    setMessage('')
    setFailure('')
    try {
      await task()
      setMessage(success)
    } catch (e) {
      setFailure(e instanceof Error ? e.message : 'The action failed. Please retry.')
    } finally {
      setBusy(false)
    }
  }
  const enableBrowserNotices = async () => {
    if (!('Notification' in window)) {
      setFailure('This browser does not support desktop notifications. In-app alerts remain available.')
      return
    }
    const permission = await Notification.requestPermission()
    localStorage.setItem('aq-desktop-notifications', permission === 'granted' ? 'true' : 'false')
    setMessage(
      permission === 'granted'
        ? 'Desktop notifications enabled while this dashboard is open.'
        : 'Permission was not granted. In-app alerts still work.',
    )
  }
  const errors = [fleet.error, events.error, rules.error, notes.error, jobs.error, settings.error].filter(Boolean)
  return (
    <div className="page operations-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Keep the network dependable</span>
          <h1>Operations</h1>
          <p>Cloud-evaluated alerts, a deployment logbook, and visibility into every CSV sync.</p>
        </div>
        <button
          className="button secondary"
          onClick={() => {
            fleet.reload()
            events.reload()
            rules.reload()
            notes.reload()
            jobs.reload()
            settings.reload()
          }}
        >
          <RefreshCw size={16} />
          Refresh
        </button>
      </section>
      <div className="research-summary">
        <div>
          <span>Open alerts</span>
          <strong>{events.data.filter((e) => !e.resolved_at).length}</strong>
        </div>
        <div>
          <span>Active rules</span>
          <strong>{rules.data.filter((r) => r.enabled).length}</strong>
        </div>
        <div>
          <span>Pending CSV jobs</span>
          <strong>{jobs.data.filter((j) => ['queued', 'waiting', 'processing'].includes(j.status)).length}</strong>
        </div>
        <div>
          <span>Next scheduled sync</span>
          <strong>
            {new Date(closedSyncWindow() + 43200000).toLocaleTimeString('en-GB', {
              timeZone: 'Asia/Kolkata',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            <small>IST</small>
          </strong>
        </div>
      </div>
      <nav className="research-tabs" aria-label="Operations views">
        {(
          [
            { key: 'alerts', label: 'Alerts', icon: Bell },
            { key: 'notes', label: 'Deployment notes', icon: NotebookPen },
            { key: 'sync', label: 'CSV sync', icon: CloudDownload },
          ] as const
        ).map(({ key, label, icon: Icon }) => (
          <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>
            <Icon size={17} />
            {label}
          </button>
        ))}
      </nav>
      {message && (
        <div className="success-banner" role="status">
          <Check size={16} />
          {message}
        </div>
      )}
      {(failure || errors.length > 0) && (
        <div className="error-banner" role="alert">
          {failure || errors[0]}
        </div>
      )}
      {tab !== 'sync' && (
        <label className="operations-device">
          Logger
          <select
            value={deviceId}
            onChange={(e) => {
              setDeviceId(e.target.value)
              setMetric('offline')
            }}
          >
            {fleet.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.code} · {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {tab === 'alerts' && (
        <>
          <div className="operations-grid">
            <section className="panel operations-card">
              <span className="eyebrow">Define what matters</span>
              <h2>New alert rule</h2>
              <p>
                Evaluated every minute using existing heartbeats and five-minute snapshots. Rules are shared with your
                research team.
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  void run(
                    () =>
                      workspaceWrite('alert_rules', 'insert', {
                        device_id: deviceId,
                        metric,
                        threshold,
                        direction,
                        duration_minutes: duration,
                        enabled: true,
                      }),
                    'Alert rule saved. Cloud evaluation is active.',
                  )
                }}
              >
                <label>
                  Condition
                  <select value={metric} onChange={(e) => setMetric(e.target.value)}>
                    <option value="offline">Logger offline</option>
                    {metrics
                      .filter((m) => m.key !== 'co2' || device?.co2Enabled)
                      .map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label} · {m.unit}
                        </option>
                      ))}
                  </select>
                </label>
                {metric !== 'offline' && (
                  <div className="research-filter-row">
                    <label>
                      Direction
                      <select value={direction} onChange={(e) => setDirection(e.target.value)}>
                        <option value="above">Above</option>
                        <option value="below">Below</option>
                      </select>
                    </label>
                    <label>
                      Threshold · {metrics.find((m) => m.key === metric)?.unit}
                      <input
                        required
                        type="number"
                        step="any"
                        min={metric === 'temperature' ? -80 : 0}
                        max={1000000}
                        value={threshold}
                        onChange={(e) => setThreshold(Number(e.target.value))}
                      />
                    </label>
                  </div>
                )}
                <label>
                  {metric === 'offline' ? 'No heartbeat for' : 'Sustained for'} · minutes
                  <input
                    required
                    type="number"
                    min={5}
                    max={1440}
                    value={duration}
                    onChange={(e) => setDuration(Number(e.target.value))}
                  />
                </label>
                <button className="button primary" disabled={busy || !deviceId}>
                  <Plus size={16} />
                  Add rule
                </button>
              </form>
              <p className="research-source-note">
                These are research thresholds, not health classifications. Missing samples do not count as threshold
                breaches. Create an offline rule separately.
              </p>
            </section>
            <section className="panel operations-card">
              <span className="eyebrow">Notification delivery</span>
              <h2>Know when attention is needed</h2>
              <p>
                Alerts are recorded even when your browser is closed. Acknowledgement records that someone has reviewed
                an event; it does not change the measurements.
              </p>
              <button className="button secondary" onClick={() => void enableBrowserNotices()}>
                <Bell size={16} />
                Enable desktop notifications
              </button>
              <p className="research-source-note">
                Desktop delivery needs browser permission and an open dashboard. Email and SMS are not configured. The
                event history is always available here.
              </p>
              <h3>Rules for {device?.code}</h3>
              {rules.loading ? (
                <p role="status">Loading rules…</p>
              ) : !rules.data.some((r) => r.device_id === deviceId) ? (
                <p>No rules yet for this logger.</p>
              ) : (
                rules.data
                  .filter((r) => r.device_id === deviceId)
                  .map((rule) => (
                    <div className="operation-list-row" key={rule.id}>
                      <div>
                        <strong>
                          {rule.metric === 'offline'
                            ? `Offline for ${rule.duration_minutes} min`
                            : `${metrics.find((m) => m.key === rule.metric)?.label} ${rule.direction} ${rule.threshold}`}
                        </strong>
                        <small>
                          {rule.enabled ? 'Enabled' : 'Paused'} · {rule.duration_minutes} minute window
                        </small>
                      </div>
                      <button
                        className="button secondary small"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => workspaceWrite('alert_rules', 'update', { enabled: !rule.enabled }, rule.id),
                            'Rule updated.',
                          )
                        }
                      >
                        {rule.enabled ? 'Pause' : 'Enable'}
                      </button>
                      <button
                        className="icon-btn"
                        aria-label={`Delete ${rule.metric} rule`}
                        disabled={busy}
                        onClick={() => {
                          if (window.confirm('Delete this rule and its event history? This cannot be undone.'))
                            void run(
                              () => workspaceWrite('alert_rules', 'delete', {}, rule.id),
                              'Rule and its associated event history deleted.',
                            )
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))
              )}
            </section>
          </div>
          <section className="panel operations-card">
            <div className="section-head">
              <div>
                <span className="eyebrow">Network-wide event history</span>
                <h2>Attention inbox</h2>
              </div>
              <label className="operations-checkbox">
                <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} />
                Open events only
              </label>
            </div>
            {events.loading ? (
              <p role="status">Loading alerts…</p>
            ) : !events.data.filter((e) => !onlyOpen || !e.resolved_at).length ? (
              <div className="empty compact">
                <ShieldMessage />
                <h3>No {onlyOpen ? 'open ' : ''}alerts</h3>
                <p>
                  {rules.data.length
                    ? 'No matching events in the latest 200 records.'
                    : 'Add a rule to start cloud monitoring.'}
                </p>
              </div>
            ) : (
              events.data
                .filter((e) => !onlyOpen || !e.resolved_at)
                .map((event) => (
                  <article className="alert-event" key={event.id}>
                    <span className={`operation-status ${event.resolved_at ? 'completed' : 'failed'}`}>
                      {event.resolved_at ? 'Resolved' : 'Open'}
                    </span>
                    <div>
                      <strong>{event.message}</strong>
                      <small>
                        {time(event.opened_at)}
                        {event.acknowledged_at ? ' · Acknowledged' : ''}
                      </small>
                    </div>
                    {!event.acknowledged_at && (
                      <button
                        className="button secondary small"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              demoMode
                                ? workspaceWrite(
                                    'alert_events',
                                    'update',
                                    { acknowledged_at: new Date().toISOString() },
                                    event.id,
                                  )
                                : workspaceRpc('acknowledge_alert', { p_id: event.id }),
                            'Alert acknowledged.',
                          )
                        }
                      >
                        Acknowledge
                      </button>
                    )}
                  </article>
                ))
            )}
          </section>
        </>
      )}
      {tab === 'notes' && (
        <div className="operations-grid">
          <section className="panel operations-card">
            <span className="eyebrow">Field logbook</span>
            <h2>Add a deployment note</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  await workspaceWrite('deployment_notes', 'insert', {
                    device_id: deviceId,
                    kind,
                    location: location.trim(),
                    body: body.trim(),
                    occurred_at: new Date(occurred + ':00+05:30').toISOString(),
                  })
                  setBody('')
                }, 'Note saved to the shared deployment log.')
              }}
            >
              <label>
                Event type
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="observation">Observation</option>
                  <option value="deployment">Installation / relocation</option>
                  <option value="maintenance">Maintenance</option>
                  <option value="cleaning">Sensor cleaning</option>
                </select>
              </label>
              <label>
                Occurred at · IST
                <input type="datetime-local" required value={occurred} onChange={(e) => setOccurred(e.target.value)} />
              </label>
              <label>
                Room / location
                <input
                  maxLength={200}
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Block V · rooftop, north side"
                />
              </label>
              <label>
                Note
                <textarea
                  required
                  minLength={1}
                  maxLength={4000}
                  rows={5}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Record installation details, maintenance, or context for unusual readings."
                />
              </label>
              <button className="button primary" disabled={busy || !body.trim() || !deviceId}>
                <NotebookPen size={16} />
                Save note
              </button>
            </form>
          </section>
          <section className="panel operations-card">
            <span className="eyebrow">{device?.code}</span>
            <h2>Deployment timeline</h2>
            {notes.loading ? (
              <p role="status">Loading notes…</p>
            ) : !notes.data.some((n) => n.device_id === deviceId) ? (
              <div className="empty compact">
                <NotebookPen size={28} />
                <h3>Your logbook starts here</h3>
                <p>Record where this logger was installed and what changed.</p>
              </div>
            ) : (
              notes.data
                .filter((n) => n.device_id === deviceId)
                .map((note) => (
                  <article className="deployment-note" key={note.id}>
                    <span>
                      {note.kind} · {time(note.occurred_at)}
                    </span>
                    {note.location && <h3>{note.location}</h3>}
                    <p>{note.body}</p>
                  </article>
                ))
            )}
          </section>
        </div>
      )}
      {tab === 'sync' && (
        <section className="panel operations-card">
          <div className="section-head">
            <div>
              <span className="eyebrow">Midnight & noon · IST</span>
              <h2>CSV collection</h2>
              <p>The next scheduled run is {time(new Date(closedSyncWindow() + 43200000).toISOString())}.</p>
            </div>
          </div>
          <p className="research-source-note">
            Sync now retries a download through the latest scheduled midnight/noon cutoff; it does not change the
            twice-daily schedule. Limited to one manual request per logger per 15 minutes. Pausing allows active
            transfers to finish. SD files are never modified.
          </p>
          <div className="table-scroll sync-table-wrap">
            <table className="research-table sync-table">
              <thead>
                <tr>
                  <th>Logger</th>
                  <th>Automatic sync</th>
                  <th>Latest job</th>
                  <th>Last completed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {fleet.data.map((d) => {
                  const job = jobs.data.find((j) => j.device_id === d.id),
                    setting = settings.data.find((s) => s.device_id === d.id),
                    enabled = setting?.enabled ?? true
                  return (
                    <tr key={d.id}>
                      <th>
                        <Link to={`/device/${d.code}/history`}>{d.code}</Link>
                      </th>
                      <td data-label="Automatic sync">{enabled ? 'Twice daily' : 'Paused'}</td>
                      <td data-label="Latest job">
                        <span className={`operation-status ${job?.status ?? ''}`}>
                          {job?.status ?? (demoMode ? 'Demo' : 'Not started')}
                        </span>
                        {job?.error_message && <small className="sync-error">{job.error_message}</small>}
                      </td>
                      <td data-label="Last completed">{job?.completed_at ? formatRelative(job.completed_at) : '—'}</td>
                      <td data-label="Actions">
                        <div className="research-actions">
                          <button
                            className="button secondary small"
                            disabled={busy || !enabled}
                            onClick={() =>
                              void run(
                                () => workspaceRpc('request_history_sync', { p_device: d.id }),
                                demoMode
                                  ? 'Demo: a CSV refresh would be queued.'
                                  : 'CSV refresh queued. Keep the logger online.',
                              )
                            }
                          >
                            Sync now
                          </button>
                          <button
                            className="button secondary small"
                            disabled={busy}
                            onClick={() =>
                              void run(
                                async () => {
                                  if (demoMode) {
                                    const rows = settings.data.filter((s) => s.device_id !== d.id)
                                    localStorage.setItem(
                                      'aq-demo-csv_history_settings',
                                      JSON.stringify([...rows, { device_id: d.id, enabled: !enabled }]),
                                    )
                                    settings.reload()
                                    return
                                  }
                                  const result = await supabase!
                                    .from('csv_history_settings')
                                    .update({ enabled: !enabled })
                                    .eq('device_id', d.id)
                                    .select('device_id')
                                    .single()
                                  if (result.error) throw result.error
                                  settings.reload()
                                },
                                enabled
                                  ? `${code(d.id)} automatic sync paused.`
                                  : `${code(d.id)} automatic sync resumed.`,
                              )
                            }
                          >
                            {enabled ? 'Pause' : 'Resume'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
function ShieldMessage() {
  return <Check size={26} />
}
