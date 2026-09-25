import { ArrowRight, ArrowUpRight, Clock3, Filter, RadioTower, Search, SlidersHorizontal, Wifi } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { StatusBadge } from '../components/StatusBadge'
import { useDevices, useTodayTelemetryCount } from '../hooks/useData'
import { usePreferences } from '../hooks/usePreferences'
import { formatRelative, getDeviceState, rssiQuality } from '../utils'

type FilterKey = 'all' | 'online' | 'attention'
type SortKey = 'device' | 'last_seen' | 'pm25'

export function FleetPage() {
  const { data: devices, loading, error, reload } = useDevices()
  const telemetryToday = useTodayTelemetryCount()
  const { preferences } = usePreferences()
  const thresholds = useMemo(
    () => ({ onlineMinutes: preferences.onlineMinutes, staleMinutes: preferences.staleMinutes }),
    [preferences.onlineMinutes, preferences.staleMinutes],
  )
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [sort, setSort] = useState<SortKey>('device')
  const filtered = useMemo(
    () =>
      devices
        .filter((device) => {
          const state = getDeviceState(device.lastSeen, new Date(), thresholds)
          return (
            (device.code + device.name + device.location).toLowerCase().includes(query.toLowerCase()) &&
            (filter === 'all' || (filter === 'online' ? state === 'online' : state !== 'online'))
          )
        })
        .sort((a, b) =>
          sort === 'last_seen'
            ? new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime()
            : sort === 'pm25'
              ? (b.latest.pm25 ?? -1) - (a.latest.pm25 ?? -1)
              : a.code.localeCompare(b.code),
        ),
    [devices, filter, query, sort, thresholds],
  )
  const states = devices.map((device) => getDeviceState(device.lastSeen, new Date(), thresholds))
  const online = states.filter((state) => state === 'online').length
  const stale = states.filter((state) => state === 'stale').length
  const offline = states.filter((state) => state === 'offline').length
  const availability = devices.length ? Math.round((online / devices.length) * 100) : 0
  return (
    <div className="page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Environmental monitoring network</span>
          <h1>Fleet overview</h1>
          <p>Live operational state and latest five-minute summaries from every field logger.</p>
        </div>
        <button className="last-updated refresh-plain" onClick={reload}>
          <span className="live-pulse" />
          <div>
            <small>{loading ? 'Refreshing' : 'Auto-refresh active'}</small>
            <strong>{loading ? 'Please wait...' : `Every ${preferences.refreshSeconds}s`}</strong>
          </div>
        </button>
      </section>
      {error && (
        <div className="error-banner" role="alert">
          Could not refresh devices. {error} <button onClick={reload}>Retry</button>
        </div>
      )}
      <section className="summary-grid">
        <div className="summary-card feature">
          <div>
            <span>Network availability</span>
            <strong>
              {availability}
              <small>%</small>
            </strong>
            <p>
              {online} of {devices.length} loggers reporting normally
            </p>
          </div>
          <div
            className="availability-ring"
            style={{ '--value': `${devices.length ? (online / devices.length) * 360 : 0}deg` } as React.CSSProperties}
          >
            <span>
              {online}/{devices.length}
            </span>
          </div>
        </div>
        <div className="summary-card">
          <span>Online now</span>
          <strong>{online}</strong>
          <small className="positive">
            <ArrowUpRight size={14} /> Heartbeat healthy
          </small>
        </div>
        <div className="summary-card">
          <span>Needs attention</span>
          <strong>{stale + offline}</strong>
          <small>
            {stale} stale · {offline} offline
          </small>
        </div>
        <div className="summary-card">
          <span>Telemetry today</span>
          <strong>{telemetryToday.loading ? '—' : telemetryToday.data.toLocaleString()}</strong>
          <small>{telemetryToday.error ? 'Count unavailable' : 'Five-minute records'}</small>
        </div>
      </section>
      <section className="section-head">
        <div>
          <h2>Field loggers</h2>
          <p>
            {filtered.length} {filtered.length === 1 ? 'device' : 'devices'} shown
          </p>
        </div>
        <div className="controls">
          <label className="search">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search loggers..."
              aria-label="Search loggers"
            />
          </label>
          <div className="filter-wrap">
            <Filter size={15} />
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as FilterKey)}
              aria-label="Filter devices"
            >
              <option value="all">All devices</option>
              <option value="online">Online</option>
              <option value="attention">Needs attention</option>
            </select>
          </div>
          <div className="filter-wrap">
            <SlidersHorizontal size={15} />
            <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} aria-label="Sort devices">
              <option value="device">Device ID</option>
              <option value="last_seen">Last seen</option>
              <option value="pm25">Highest PM2.5</option>
            </select>
          </div>
        </div>
      </section>
      {loading && !devices.length ? (
        <section className="device-grid" aria-label="Loading devices">
          {Array.from({ length: 4 }, (_, index) => (
            <div className="device-card skeleton-card" key={index}>
              <span />
              <span />
              <span />
              <span />
            </div>
          ))}
        </section>
      ) : (
        <section className="device-grid">
          {filtered.map((device) => {
            const state = getDeviceState(device.lastSeen, new Date(), thresholds)
            return (
              <article className="device-card" key={device.id}>
                <div className="device-card-top">
                  <div className="device-id">
                    <span className="device-icon">
                      <RadioTower size={19} />
                    </span>
                    <div>
                      <span>{device.code}</span>
                      <h3>{device.name}</h3>
                    </div>
                  </div>
                  <StatusBadge state={state} />
                </div>
                <p className="location">{device.location}</p>
                <div className={`device-readings ${device.co2Enabled ? 'has-co2' : ''}`}>
                  <div>
                    <small>PM1</small>
                    <strong>{device.latest.pm1?.toFixed(1) ?? '—'}</strong>
                    <span>µg/m³</span>
                  </div>
                  <div>
                    <small>PM2.5</small>
                    <strong>{device.latest.pm25?.toFixed(1) ?? '—'}</strong>
                    <span>µg/m³</span>
                  </div>
                  <div>
                    <small>PM10</small>
                    <strong>{device.latest.pm10?.toFixed(1) ?? '—'}</strong>
                    <span>µg/m³</span>
                  </div>
                  <div>
                    <small>Temp.</small>
                    <strong>{device.latest.temperature?.toFixed(1) ?? '—'}</strong>
                    <span>°C</span>
                  </div>
                  <div>
                    <small>Humidity</small>
                    <strong>{device.latest.rh?.toFixed(0) ?? '—'}</strong>
                    <span>%</span>
                  </div>
                  {device.co2Enabled && (
                    <div>
                      <small>CO₂</small>
                      <strong>{device.latest.co2?.toFixed(0) ?? '—'}</strong>
                      <span>ppm</span>
                    </div>
                  )}
                </div>
                <div className="device-meta">
                  <span>
                    <Wifi size={15} />
                    <span>
                      {device.rssi} dBm · {rssiQuality(device.rssi)}
                    </span>
                  </span>
                  <span>
                    <Clock3 size={15} />
                    <span>{formatRelative(device.lastSeen)}</span>
                  </span>
                </div>
                <Link className="device-link" to={`/device/${device.code}`}>
                  <span>Open dashboard</span>
                  <ArrowRight size={17} />
                </Link>
              </article>
            )
          })}
        </section>
      )}
      {!loading && !filtered.length && (
        <div className="empty">
          <Search size={24} />
          <h3>{devices.length ? 'No loggers found' : 'No devices registered'}</h3>
          <p>
            {devices.length
              ? 'Try changing the search or status filter.'
              : 'Register a logger in Supabase to begin monitoring.'}
          </p>
        </div>
      )}
    </div>
  )
}
