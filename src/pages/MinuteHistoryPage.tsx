import { ArrowLeft, CalendarDays, CloudDownload, Pause, Play, RefreshCw } from 'lucide-react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMemo, useState } from 'react'
import { useDevices } from '../hooks/useData'
import { useMinuteHistory } from '../hooks/useMinuteHistory'
import { TelemetryChart } from '../components/TelemetryChart'
import { readOnlyMode } from '../services/supabase'
import { formatFileSize, formatRelative } from '../utils'
import { istDate, minuteTimeline } from '../utils/minuteHistory'

const jobLabels = {
  queued: 'Download scheduled',
  waiting: 'Waiting for the logger’s CSV',
  processing: 'Calculating minute averages',
  completed: 'CSV import complete',
  failed: 'CSV import needs attention',
}

export function MinuteHistoryPage() {
  const { code } = useParams()
  const navigate = useNavigate()
  const devices = useDevices()
  const device = devices.data.find((d) => d.code === code)
  const [date, setDate] = useState(istDate())
  const history = useMinuteHistory(device?.id, date, device?.co2Enabled ?? false)
  const timeline = useMemo(() => minuteTimeline(history.rows, date), [history.rows, date])
  const sampleRows = history.rows.reduce((sum, row) => sum + row.sampleCount, 0)
  if (!device)
    return (
      <div className="page">
        <Link className="back-link" to="/">
          All devices
        </Link>
        <div className="empty">
          <h2>{devices.loading ? 'Loading logger…' : 'Logger unavailable'}</h2>
          <p>{devices.error ?? 'Select a registered logger from the overview.'}</p>
        </div>
      </div>
    )

  return (
    <div className="page">
      <Link className="back-link" to={`/device/${device.code}`}>
        <ArrowLeft size={16} /> {device.code} dashboard
      </Link>
      <section className="page-heading history-page-heading">
        <div>
          <span className="eyebrow">Twice-daily CSV sync</span>
          <h1>One-minute history</h1>
          <p>
            {device.code} · {device.name} · averages calculated from SD-card CSV readings.
          </p>
        </div>
        <label className="history-device-picker">
          Logger
          <select
            aria-label="History logger"
            value={device.code}
            onChange={(e) => navigate(`/device/${e.target.value}/history`)}
          >
            {devices.data.map((d) => (
              <option key={d.id} value={d.code}>
                {d.code} · {d.name}
              </option>
            ))}
          </select>
        </label>
      </section>
      <nav className="history-tabs" aria-label="Device views">
        <Link to={`/device/${device.code}`}>Live readings</Link>
        <Link aria-current="page" to={`/device/${device.code}/history`}>
          One-minute history
        </Link>
      </nav>
      <section className="panel history-sync-panel" aria-label="Twice-daily CSV sync status">
        <div className="history-sync-heading">
          <CloudDownload size={24} />
          <div>
            <h2>{history.enabled ? 'Automatic twice-daily downloads' : 'Automatic downloads paused'}</h2>
            <p>
              {history.job?.status === 'completed' && history.job.imported_minutes === 0
                ? 'CSV received; no readings before this sync cutoff'
                : history.job
                  ? jobLabels[history.job.status]
                  : 'Waiting for the first scheduled CSV download'}
            </p>
          </div>
          <span className={`history-sync-badge ${history.enabled ? 'active' : ''}`}>
            {history.enabled ? '00:00 & 12:00 IST' : 'Paused'}
          </span>
        </div>
        <p>
          At midnight and noon IST, the cloud requests the logger’s weekly CSV and averages its rows into one-minute
          points. Your browser can be closed. Data before the latest scheduled cutoff appears here; missing values stay
          missing.
        </p>
        <div className="history-sync-meta">
          <span>
            Last import{' '}
            <strong>
              {history.job?.completed_at
                ? formatRelative(history.job.completed_at)
                : history.sync
                  ? formatRelative(history.sync.last_imported_at)
                  : 'Not yet imported'}
            </strong>
          </span>
          <span>
            Data through{' '}
            <strong>
              {history.sync
                ? new Date(history.sync.latest_minute).toLocaleString('en-GB', {
                    timeZone: 'Asia/Kolkata',
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }) + ' IST'
                : history.job?.status === 'completed'
                  ? 'Awaiting eligible readings'
                  : 'Waiting for CSV'}
            </strong>
          </span>
          <span>
            Last CSV size{' '}
            <strong>
              {history.job?.source_bytes != null ? formatFileSize(history.job.source_bytes) : 'Not yet available'}
            </strong>
          </span>
        </div>
        {history.job?.error_message && (
          <div className="inline-notice warning" role="status">
            {history.job.error_message}
          </div>
        )}
        <div className="history-sync-actions">
          <button className="button secondary" onClick={history.reload}>
            <RefreshCw size={16} /> Refresh status
          </button>
          {!readOnlyMode && (
            <button className="button secondary" disabled={history.saving} onClick={() => void history.toggle()}>
              {history.enabled ? <Pause size={16} /> : <Play size={16} />}
              {history.enabled ? 'Pause automatic sync' : 'Resume automatic sync'}
            </button>
          )}
        </div>
        <small className="history-bandwidth-note">
          The existing logger transfers the full weekly file twice daily. Failed transfers may retry, and weekly
          rollover includes the previous file. Temporary cloud copies are removed after import; SD originals stay on the
          logger.
        </small>
      </section>
      <section className="section-head history-date-head">
        <div>
          <h2>Minute averages</h2>
          <p>Times shown in IST · each point averages the valid CSV samples in that minute.</p>
        </div>
        <label className="history-date-picker">
          <CalendarDays size={17} /> Day (IST)
          <input
            aria-label="History date"
            type="date"
            value={date}
            max={istDate()}
            onChange={(e) => {
              if (e.target.value) setDate(e.target.value)
            }}
          />
        </label>
      </section>
      <div className="history-coverage">
        <span>
          <strong>{history.rows.length.toLocaleString()}</strong> recorded minutes
        </span>
        <span>
          <strong>{timeline.length.toLocaleString()}</strong> minutes due by latest sync
        </span>
        <span>
          <strong>{sampleRows.toLocaleString()}</strong> CSV rows averaged
        </span>
      </div>
      {history.error && (
        <div className="error-banner" role="alert">
          {history.error} <button onClick={history.reload}>Retry</button>
        </div>
      )}
      {history.loading ? (
        <div className="empty" role="status">
          Loading one-minute history…
        </div>
      ) : !history.rows.length ? (
        <div className="empty">
          <CloudDownload size={28} />
          <h3>No CSV averages for this day yet</h3>
          <p>
            Keep the logger online with its SD card available. CSV imports run at midnight and noon IST. Before noon,
            select an earlier day to see imported readings.
          </p>
        </div>
      ) : (
        <div className="chart-grid">
          <TelemetryChart
            title="Particles · PM1"
            unit="µg/m³"
            data={timeline}
            dataKey="pm1"
            color="#0a86a5"
            timeZone="Asia/Kolkata"
          />
          <TelemetryChart
            title="Fine particles · PM2.5"
            unit="µg/m³"
            data={timeline}
            dataKey="pm25"
            color="#2571c6"
            timeZone="Asia/Kolkata"
          />
          <TelemetryChart
            title="Particles · PM10"
            unit="µg/m³"
            data={timeline}
            dataKey="pm10"
            color="#7657c8"
            timeZone="Asia/Kolkata"
          />
          <TelemetryChart
            title="Temperature"
            unit="°C"
            data={timeline}
            dataKey="temperature"
            color="#d27c26"
            timeZone="Asia/Kolkata"
          />
          <TelemetryChart
            title="Relative humidity"
            unit="%"
            data={timeline}
            dataKey="rh"
            color="#188c81"
            timeZone="Asia/Kolkata"
          />
          {device.co2Enabled && (
            <TelemetryChart
              title="Carbon dioxide · CO₂"
              unit="ppm"
              data={timeline}
              dataKey="co2"
              color="#53945e"
              decimals={0}
              timeZone="Asia/Kolkata"
            />
          )}
        </div>
      )}
      <p className="history-footnote">
        Gaps may reflect missing CSV rows, unavailable sensors, or periods before the first import. Recovery files with
        an unverified clock are excluded. A partial minute uses only its available valid samples.
      </p>
    </div>
  )
}
