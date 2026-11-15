import {
  AlertTriangle,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Filter,
  RadioTower,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Wifi,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { StatusBadge } from '../components/StatusBadge'
import { useDevices, useTodayTelemetryCount } from '../hooks/useData'
import type { FleetCatalogRefreshContext } from '../hooks/useFleetCatalogRefresh'
import { usePreferences } from '../hooks/usePreferences'
import { demoMode, readOnlyMode } from '../services/supabase'
import { queueFileListCommand } from '../services/fileCatalog'
import { formatRelative, rssiQuality } from '../utils'
import { assessDevice, assessmentRank } from '../utils/deviceInsights'
import type { FleetCatalogItem } from '../utils/fileCatalogBatch'

type FilterKey = 'all' | 'online' | 'attention'
type SortKey = 'attention' | 'device' | 'last_seen' | 'pm25'

const checkedTime = (value: number) =>
  `${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value)} IST`

export function FleetPage() {
  const catalogRefresh = useOutletContext<FleetCatalogRefreshContext>()
  const { data: devices, loading, error, reload, checkedAt } = useDevices()
  const telemetryToday = useTodayTelemetryCount()
  const { preferences } = usePreferences()
  const thresholds = useMemo(
    () => ({ onlineMinutes: preferences.onlineMinutes, staleMinutes: preferences.staleMinutes }),
    [preferences.onlineMinutes, preferences.staleMinutes],
  )
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [sort, setSort] = useState<SortKey>('attention')
  const [queueingLists, setQueueingLists] = useState(false)
  const [catalogNotice, setCatalogNotice] = useState<{ text: string; error: boolean } | null>(null)
  const refreshAllLists = async () => {
    if (queueingLists || (catalogRefresh.summary?.pending ?? 0) > 0 || !devices.length) return
    setQueueingLists(true)
    setCatalogNotice(null)
    if (demoMode) {
      setCatalogNotice({ text: `Demo only: no commands were sent to the ${devices.length} loggers.`, error: false })
      setQueueingLists(false)
      return
    }

    // Use the full fleet, including filtered and offline loggers. Limit concurrent requests.
    const items: FleetCatalogItem[] = []
    for (let index = 0; index < devices.length; index += 4) {
      const results = await Promise.all(
        devices.slice(index, index + 4).map(async (device) => {
          try {
            const command = await queueFileListCommand(device.id)
            return {
              deviceId: device.id,
              code: device.code,
              commandId: command.commandId,
              status: command.status,
              errorMessage: null,
            } satisfies FleetCatalogItem
          } catch (error) {
            return {
              deviceId: device.id,
              code: device.code,
              commandId: null,
              status: 'request_failed',
              errorMessage: error instanceof Error ? error.message : 'Request failed.',
            } satisfies FleetCatalogItem
          }
        }),
      )
      items.push(...results)
    }
    catalogRefresh.startBatch(items)
    setQueueingLists(false)
  }
  const assessed = useMemo(() => {
    const now = new Date()
    return devices.map((device) => ({ device, assessment: assessDevice(device, now, thresholds) }))
  }, [devices, thresholds])
  const attention = assessed.filter(({ assessment }) => assessment.issues.length)
  const filtered = useMemo(
    () =>
      assessed
        .filter(({ device, assessment }) => {
          const matches = (device.code + device.name + device.location).toLowerCase().includes(query.toLowerCase())
          return (
            matches &&
            (filter === 'all' || (filter === 'online' ? assessment.state === 'online' : !!assessment.issues.length))
          )
        })
        .sort((a, b) =>
          sort === 'last_seen'
            ? new Date(b.device.lastSeen).getTime() - new Date(a.device.lastSeen).getTime()
            : sort === 'pm25'
              ? (b.device.latest.pm25 ?? -1) - (a.device.latest.pm25 ?? -1)
              : sort === 'attention'
                ? assessmentRank(a.assessment) - assessmentRank(b.assessment) ||
                  a.device.code.localeCompare(b.device.code)
                : a.device.code.localeCompare(b.device.code),
        ),
    [assessed, filter, query, sort],
  )
  const states = assessed.map(({ assessment }) => assessment.state)
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
          <p>Latest cloud contact and fifteen-minute summaries from every field logger.</p>
        </div>
        <button className="last-updated refresh-plain" onClick={reload} aria-label="Refresh cloud status">
          <RefreshCw className={loading ? 'spin' : ''} size={18} />
          <div>
            <small>
              {loading
                ? 'Checking cloud status'
                : error
                  ? 'Cloud check failed'
                  : preferences.realtime
                    ? 'Cloud checked · auto-refresh on'
                    : 'Cloud checked · auto-refresh off'}
            </small>
            <strong>{checkedAt ? checkedTime(checkedAt) : 'Waiting for first check'}</strong>
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
              {online} of {devices.length} loggers with recent cloud contact
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
            <ArrowUpRight size={14} /> Recent cloud contact
          </small>
        </div>
        <div className="summary-card">
          <span>Needs attention</span>
          <strong>{attention.length}</strong>
          <small>
            {offline} offline · {stale} delayed ·{' '}
            {attention.filter(({ assessment }) => assessment.state === 'online').length} online with issues
          </small>
        </div>
        <div className="summary-card">
          <span>Telemetry today</span>
          <strong>{telemetryToday.loading ? '—' : telemetryToday.data.toLocaleString()}</strong>
          <small>{telemetryToday.error ? 'Count unavailable' : 'Fifteen-minute records'}</small>
        </div>
      </section>
      <section className="fleet-triage" aria-labelledby="fleet-triage-title">
        <div className="fleet-triage-head">
          <div>
            <span className="eyebrow">What needs a closer look</span>
            <h2 id="fleet-triage-title">Attention queue</h2>
            <p>Checks use the latest cloud report. A healthy connection does not confirm SD recording.</p>
          </div>
          {attention.length > 4 && (
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setFilter('attention')
                document.getElementById('field-loggers')?.scrollIntoView({ behavior: 'smooth' })
              }}
            >
              View all {attention.length}
            </button>
          )}
        </div>
        {attention.length ? (
          <div className="fleet-triage-list">
            {attention
              .slice()
              .sort((a, b) => assessmentRank(a.assessment) - assessmentRank(b.assessment))
              .slice(0, 4)
              .map(({ device, assessment }) => (
                <Link className="fleet-triage-row" to={`/device/${device.code}`} key={device.id}>
                  <span className={`fleet-triage-icon ${assessment.issues[0].severity}`}>
                    <AlertTriangle size={18} />
                  </span>
                  <span className="fleet-triage-device">
                    <strong>{device.name}</strong>
                    <small>
                      {device.code} · Last contact {formatRelative(device.lastSeen)}
                    </small>
                  </span>
                  <span className="fleet-triage-reasons">
                    {assessment.issues.slice(0, 2).map((issue) => (
                      <span className={`fleet-issue ${issue.severity}`} title={issue.detail} key={issue.id}>
                        {issue.label}
                      </span>
                    ))}
                    {assessment.issues.length > 2 && <small>+{assessment.issues.length - 2} more</small>}
                  </span>
                  <ArrowRight className="fleet-triage-arrow" size={18} />
                </Link>
              ))}
          </div>
        ) : (
          <div className="fleet-triage-clear">
            <CheckCircle2 size={19} />{' '}
            {devices.length ? 'No attention items in the latest cloud report.' : 'No loggers to assess yet.'}
          </div>
        )}
      </section>
      <section className="section-head" id="field-loggers">
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
              <option value="attention">Attention first</option>
              <option value="device">Device ID</option>
              <option value="last_seen">Last seen</option>
              <option value="pm25">Highest PM2.5</option>
            </select>
          </div>
          {!readOnlyMode && (
            <button
              className="button secondary fleet-refresh-all"
              onClick={() => void refreshAllLists()}
              disabled={queueingLists || (catalogRefresh.summary?.pending ?? 0) > 0 || loading || !devices.length}
              title="Request an SD file list from every registered logger"
            >
              <RefreshCw className={queueingLists ? 'spin' : ''} size={15} />
              {queueingLists
                ? 'Sending...'
                : (catalogRefresh.summary?.pending ?? 0) > 0
                  ? `${catalogRefresh.summary?.completed ?? 0}/${catalogRefresh.summary?.total ?? 0} refreshed`
                  : 'Refresh all lists'}
            </button>
          )}
        </div>
      </section>
      {catalogNotice && (
        <div
          className={catalogNotice.error ? 'error-banner' : 'inline-notice fleet-catalog-notice'}
          role={catalogNotice.error ? 'alert' : 'status'}
        >
          {catalogNotice.text}
        </div>
      )}
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
          {filtered.map(({ device, assessment }) => {
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
                  <StatusBadge state={assessment.state} />
                </div>
                <p className="location">{device.location}</p>
                {!!assessment.issues.length && (
                  <div className="device-issues" aria-label={`Attention items for ${device.code}`}>
                    {assessment.issues.slice(0, 2).map((issue) => (
                      <span className={`fleet-issue ${issue.severity}`} title={issue.detail} key={issue.id}>
                        {issue.label}
                      </span>
                    ))}
                    {assessment.issues.length > 2 && <small>+{assessment.issues.length - 2} more</small>}
                  </div>
                )}
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
