import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Download,
  FileText,
  RefreshCw,
  Router,
  Wifi,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DownloadModal } from '../components/DownloadModal'
import { MetricCard } from '../components/MetricCard'
import { StatusBadge } from '../components/StatusBadge'
import { TelemetryChart } from '../components/TelemetryChart'
import { useDeviceFiles, useDevices, useTelemetry } from '../hooks/useData'
import { usePreferences } from '../hooks/usePreferences'
import { readOnlyMode } from '../services/supabase'
import type { DeviceFile, RangeKey, Reading } from '../types'
import { formatDateTime, formatFileSize, formatRelative, getDeviceState, rssiQuality } from '../utils'

type ReadingKey = 'pm25' | 'pm10' | 'temperature' | 'rh'
const delta = (data: Reading[], key: ReadingKey) => {
  const values = data.map((item) => item[key]).filter((value): value is number => value !== null)
  return values.length > 1 ? values.at(-1)! - values.at(-2)! : null
}

export function DevicePage() {
  const { code } = useParams()
  const devicesState = useDevices()
  const device = devicesState.data.find((item) => item.code === code) ?? null
  const [range, setRange] = useState<RangeKey>('24h')
  const [download, setDownload] = useState<DeviceFile | null>(null)
  const [notice, setNotice] = useState('')
  const [copyLabel, setCopyLabel] = useState('')
  const telemetryState = useTelemetry(device, range)
  const filesState = useDeviceFiles(device)
  const { preferences } = usePreferences()
  const state = device
    ? getDeviceState(device.lastSeen, new Date(), {
        onlineMinutes: preferences.onlineMinutes,
        staleMinutes: preferences.staleMinutes,
      })
    : 'offline'
  const latest = useMemo(() => telemetryState.data.at(-1) ?? device?.latest, [telemetryState.data, device])
  if (devicesState.loading && !device)
    return (
      <div className="page">
        <div className="detail-skeleton">
          <span />
          <span />
          <span />
          <span />
        </div>
      </div>
    )
  if (!device)
    return (
      <div className="page">
        <Link className="back-link" to="/">
          <ArrowLeft size={16} /> All devices
        </Link>
        <div className="empty">
          <AlertTriangle size={24} />
          <h3>Device not found</h3>
          <p>{devicesState.error ?? `No registered logger matches ${code ?? 'this route'}.`}</p>
          <button className="button secondary" onClick={devicesState.reload}>
            Retry
          </button>
        </div>
      </div>
    )
  const healthChecks = [
    ['ESP32', state === 'online', 'Cloud link'],
    ['SPS30', device.health.sps30, 'Particle sensor'],
    ['SHT3x', device.health.sht3x, 'Temperature + RH'],
    ['RTC', device.health.rtc, 'Clock synchronised'],
    ['SD card', device.health.sd, 'Recording normally'],
  ] as const
  const healthy = healthChecks.filter(([, ok]) => ok).length
  const refreshFiles = async () => {
    setNotice('')
    try {
      setNotice(await filesState.requestCatalog())
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not queue file-list command')
    }
  }
  const copyId = async () => {
    await navigator.clipboard?.writeText(device.code)
    setCopyLabel('Copied')
    window.setTimeout(() => setCopyLabel(''), 1500)
  }
  return (
    <div className="page">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} /> All devices
      </Link>
      <section className="device-hero">
        <div>
          <div className="device-title-row">
            <span className="device-hero-icon">
              <Router />
            </span>
            <div>
              <span className="eyebrow">Environmental data logger</span>
              <h1>
                {device.code} <em>·</em> {device.name}
              </h1>
            </div>
          </div>
          <p>
            {device.location}{' '}
            <button className="copy-btn" aria-label="Copy device ID" onClick={copyId}>
              <Copy size={13} /> {copyLabel}
            </button>
          </p>
        </div>
        <div className="hero-status">
          <StatusBadge state={state} />
          <span>
            <Clock3 size={14} /> Last contact {formatRelative(device.lastSeen)}
          </span>
          <small>Firmware {device.firmware}</small>
        </div>
      </section>
      <section className="metrics">
        <MetricCard
          label="PM2.5"
          value={latest?.pm25 ?? null}
          unit="µg/m³"
          change={delta(telemetryState.data, 'pm25')}
          tone="blue"
          timestamp={latest?.timestamp}
        />
        <MetricCard
          label="PM10"
          value={latest?.pm10 ?? null}
          unit="µg/m³"
          change={delta(telemetryState.data, 'pm10')}
          tone="purple"
          timestamp={latest?.timestamp}
        />
        <MetricCard
          label="Temperature"
          value={latest?.temperature ?? null}
          unit="°C"
          change={delta(telemetryState.data, 'temperature')}
          tone="amber"
          timestamp={latest?.timestamp}
        />
        <MetricCard
          label="Relative humidity"
          value={latest?.rh ?? null}
          unit="%"
          change={delta(telemetryState.data, 'rh')}
          tone="teal"
          timestamp={latest?.timestamp}
        />
      </section>
      <section className="charts-section">
        <div className="section-head">
          <div>
            <h2>Environmental telemetry</h2>
            <p>Five-minute summary data · gaps indicate unavailable readings</p>
          </div>
          <div className="range-picker">
            {(['6h', '24h', '7d', '30d'] as RangeKey[]).map((item) => (
              <button key={item} className={range === item ? 'active' : ''} onClick={() => setRange(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
        {telemetryState.error && (
          <div className="error-banner">
            Could not load telemetry. {telemetryState.error} <button onClick={telemetryState.reload}>Retry</button>
          </div>
        )}
        {telemetryState.loading ? (
          <div className="chart-grid">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="chart-card chart-skeleton" key={index}>
                <span />
                <span />
                <span />
              </div>
            ))}
          </div>
        ) : (
          <div className="chart-grid">
            <TelemetryChart
              title="Fine particles · PM2.5"
              unit="µg/m³"
              data={telemetryState.data}
              dataKey="pm25"
              color="#2571c6"
            />
            <TelemetryChart
              title="Particles · PM10"
              unit="µg/m³"
              data={telemetryState.data}
              dataKey="pm10"
              color="#7657c8"
            />
            <TelemetryChart
              title="Temperature"
              unit="°C"
              data={telemetryState.data}
              dataKey="temperature"
              color="#d27c26"
            />
            <TelemetryChart
              title="Relative humidity"
              unit="%"
              data={telemetryState.data}
              dataKey="rh"
              color="#188c81"
            />
          </div>
        )}
      </section>
      <section className={`lower-grid ${readOnlyMode ? 'single' : ''}`}>
        <article className="panel health-panel">
          <div className="panel-head">
            <div>
              <span className="eyebrow">Diagnostics</span>
              <h2>System health</h2>
            </div>
            <span className={`health-score ${healthy < healthChecks.length ? 'attention' : ''}`}>
              <CheckCircle2 size={16} /> {healthy}/{healthChecks.length} checks
            </span>
          </div>
          <div className="health-list">
            {healthChecks.map(([name, ok, description]) => (
              <div key={name}>
                <span className={`check-dot ${ok ? 'ok' : 'bad'}`}>
                  {ok ? <CheckCircle2 size={15} /> : <span>!</span>}
                </span>
                <span>
                  <strong>{name}</strong>
                  <small>{description}</small>
                </span>
                <b>{ok ? 'Operational' : 'Check'}</b>
              </div>
            ))}
          </div>
          <div className="health-meta">
            <div>
              <Wifi />
              <span>
                <small>Wi-Fi signal</small>
                <strong>
                  {device.rssi} dBm · {rssiQuality(device.rssi)}
                </strong>
              </span>
            </div>
            <div>
              <Database />
              <span>
                <small>Active SD file</small>
                <strong>{device.currentFilename}</strong>
              </span>
            </div>
            <div>
              <FileText />
              <span>
                <small>Current size</small>
                <strong>{formatFileSize(device.currentFileSize)}</strong>
              </span>
            </div>
            <div>
              <Clock3 />
              <span>
                <small>Last heartbeat</small>
                <strong>{formatRelative(device.lastSeen)}</strong>
              </span>
            </div>
            <div>
              <Clock3 />
              <span>
                <small>Last cloud telemetry</small>
                <strong>{latest ? formatRelative(latest.timestamp) : 'No telemetry received'}</strong>
              </span>
            </div>
          </div>
        </article>
        {!readOnlyMode && (
          <article className="panel files-panel">
            <div className="panel-head">
              <div>
                <span className="eyebrow">On-device storage</span>
                <h2>Recent data files</h2>
              </div>
              <button
                className="button secondary"
                onClick={refreshFiles}
                disabled={filesState.loading || state === 'offline'}
              >
                <RefreshCw className={filesState.loading ? 'spin' : ''} size={15} />{' '}
                {state === 'offline' ? 'Try when online' : 'Refresh list'}
              </button>
            </div>
            {state === 'offline' && (
              <div className="inline-notice warning">
                Logger {device.code} is offline. Historical telemetry remains available; remote file operations will
                resume when it returns.
              </div>
            )}
            {notice && (
              <div className="inline-notice" role="status">
                {notice}
              </div>
            )}
            {filesState.error && (
              <div className="error-banner">
                {filesState.error} <button onClick={filesState.reload}>Retry</button>
              </div>
            )}
            <div className="file-table" role="list" aria-label="Recent logger files">
              {filesState.loading && !filesState.data.length
                ? Array.from({ length: 4 }, (_, index) => (
                    <div className="file-row file-skeleton" key={index}>
                      <span />
                      <span />
                      <span />
                    </div>
                  ))
                : filesState.data.slice(0, 4).map((file) => (
                    <div className="file-row" role="listitem" key={file.id}>
                      <span className="file-icon">
                        <FileText size={17} />
                      </span>
                      <span className="file-name">
                        <strong>{file.filename}</strong>
                        <small>{formatDateTime(file.modifiedAt)}</small>
                      </span>
                      <span className="file-size">{formatFileSize(file.size)}</span>
                      <button
                        className="icon-btn"
                        disabled={state === 'offline'}
                        onClick={() => setDownload(file)}
                        aria-label={`Download ${file.filename}`}
                      >
                        <Download size={17} />
                      </button>
                    </div>
                  ))}
            </div>
            {!filesState.loading && !filesState.data.length && (
              <div className="mini-empty">No files reported by this logger.</div>
            )}
            <Link to="/files" className="text-link">
              View all files →
            </Link>
          </article>
        )}
      </section>
      <section className="architecture-note">
        <div>
          <strong>Remote dashboard</strong>
          <span>5-minute telemetry, device health and requested CSV transfers.</span>
        </div>
        <div>
          <strong>Local dashboard</strong>
          <span>Direct logger controls available when connected to the device network.</span>
        </div>
        <p>Independent by design—cloud availability never blocks scientific logging.</p>
      </section>
      {download && (
        <DownloadModal
          file={download}
          deviceCode={device.code}
          deviceId={device.id}
          onClose={() => setDownload(null)}
        />
      )}{' '}
    </div>
  )
}
