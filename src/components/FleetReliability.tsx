import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, RefreshCw } from 'lucide-react'
import { Link } from 'react-router-dom'
import type { Device } from '../types'
import { demoMode, supabase } from '../services/supabase'
import { coverage, demoReliability, summarizeReliability, type FleetReliabilityRow } from '../utils/reliability'

const percent = (value: number | null) => (value === null ? '—' : `${value.toFixed(1)}%`)
const count = (value: number) => value.toLocaleString('en-IN')
const dateTime = (value: string) =>
  `${new Date(value).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST`

function CoverageCell({
  received,
  expected,
  label,
  note,
}: {
  received: number
  expected: number
  label: string
  note?: string
}) {
  const value = coverage(received, expected)
  return (
    <div
      className="reliability-coverage"
      aria-label={`${label}: ${percent(value)}, ${count(received)} of ${count(expected)} expected slots`}
    >
      <strong>{percent(value)}</strong>
      <div className="reliability-meter" aria-hidden="true">
        <span style={{ width: `${value ?? 0}%` }} />
      </div>
      <small>{expected ? `${count(received)} / ${count(expected)} slots` : 'Not yet eligible'}</small>
      {value !== null && <small>{(100 - value).toFixed(1)}% missing</small>}
      {note && <small className="reliability-retention">{note}</small>}
    </div>
  )
}

export function FleetReliability({ devices, refreshToken }: { devices: Device[]; refreshToken: number }) {
  const [days, setDays] = useState<7 | 30>(7)
  const [rows, setRows] = useState<FleetReliabilityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    let alive = true
    const fetchRows = async () => {
      if (demoMode) {
        if (alive) {
          setRows(
            demoReliability(
              devices.map((d) => d.id),
              days,
            ),
          )
          setLoading(false)
          setError(null)
        }
        return
      }
      const result = await supabase!.rpc('fleet_reliability', { p_days: days })
      if (!alive) return
      if (result.error) {
        setRows([])
        setError('Fleet reliability could not be loaded. Check the database migration and retry.')
      } else {
        setRows(result.data as FleetReliabilityRow[])
        setError(null)
      }
      setLoading(false)
    }
    setLoading(true)
    void fetchRows().catch(() => {
      if (alive) {
        setRows([])
        setError('Fleet reliability could not be loaded. Check your connection and retry.')
        setLoading(false)
      }
    })
    const timer = window.setInterval(() => void fetchRows(), 60000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [days, version, refreshToken, devices])

  const visible = useMemo(() => {
    const byId = new Map(devices.map((device) => [device.id, device]))
    return rows
      .map((row) => ({ row, device: byId.get(row.device_id) }))
      .filter((item): item is { row: FleetReliabilityRow; device: Device } => Boolean(item.device))
      .sort((a, b) => {
        const aCoverage = coverage(a.row.reported_snapshots, a.row.expected_snapshots)
        const bCoverage = coverage(b.row.reported_snapshots, b.row.expected_snapshots)
        return (aCoverage ?? 101) - (bCoverage ?? 101) || b.row.failed_syncs - a.row.failed_syncs
      })
  }, [devices, rows])
  const summary = useMemo(() => summarizeReliability(visible.map(({ row }) => row)), [visible])

  return (
    <section className="panel operations-card reliability-panel">
      <div className="section-head reliability-head">
        <div>
          <span className="eyebrow">Measure the data path</span>
          <h2>Fleet reliability</h2>
          <p>Reporting and CSV coverage across the last {days} completed days in IST.</p>
        </div>
        <div className="research-actions">
          <div className="reliability-period" aria-label="Reliability period">
            {[7, 30].map((value) => (
              <button
                key={value}
                className="button secondary small"
                aria-pressed={days === value}
                onClick={() => setDays(value as 7 | 30)}
              >
                {value} days
              </button>
            ))}
          </div>
          <button className="button secondary small" onClick={reload} aria-label="Refresh fleet reliability">
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>
      </div>
      <p className="research-source-note reliability-explainer">
        New loggers count from registration. Reporting availability is the proportion of five-minute slots with a
        reading—not a record of electrical uptime. CSV coverage counts imported one-minute records; delayed collections
        can lower it until they catch up. Configured data retention shortens the eligible minute period. No gaps are
        filled or estimated.
      </p>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <p className="reliability-loading" role="status">
          Loading fleet reliability…
        </p>
      ) : !visible.length ? (
        <div className="empty compact">
          <Activity size={28} />
          <h3>No reliability history yet</h3>
          <p>Completed-day reporting and CSV data will appear after a logger has been registered and collecting.</p>
        </div>
      ) : (
        <>
          <div className="reliability-kpis" aria-label="Fleet reliability summary">
            <div>
              <span>5-min reporting</span>
              <strong>{percent(summary.reportingCoverage)}</strong>
              <small>Expected snapshots received</small>
            </div>
            <div>
              <span>1-min CSV coverage</span>
              <strong>{percent(summary.minuteCoverage)}</strong>
              <small>
                {summary.minuteCoverage === null
                  ? 'No eligible minutes'
                  : `${(100 - summary.minuteCoverage).toFixed(1)}% missing`}
              </small>
            </div>
            <div>
              <span>Failed CSV jobs</span>
              <strong>{count(summary.failedSyncs)}</strong>
              <small>{count(summary.completedSyncs)} completed in period</small>
            </div>
            <div>
              <span>Loggers measured</span>
              <strong>
                {summary.eligibleDevices}
                <small> / {devices.length}</small>
              </strong>
              <small>Registered before period end</small>
            </div>
          </div>
          <div className="table-scroll sync-table-wrap reliability-table-wrap">
            <table className="research-table sync-table reliability-table">
              <thead>
                <tr>
                  <th>Logger</th>
                  <th>5-min reporting</th>
                  <th>1-min CSV history</th>
                  <th>CSV sync jobs</th>
                  <th>Latest failed job</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ row, device }) => (
                  <tr key={device.id}>
                    <th>
                      <Link to={`/device/${device.code}`}>{device.code}</Link>
                      <small>{device.name}</small>
                    </th>
                    <td data-label="5-min reporting">
                      <CoverageCell
                        received={row.reported_snapshots}
                        expected={row.expected_snapshots}
                        label={`${device.code} reporting`}
                      />
                    </td>
                    <td data-label="1-min CSV history">
                      <CoverageCell
                        received={row.recorded_minutes}
                        expected={row.expected_minutes}
                        label={`${device.code} CSV coverage`}
                        note={row.retention_days ? `${row.retention_days}-day retention` : undefined}
                      />
                    </td>
                    <td data-label="CSV sync jobs">
                      <strong className={row.failed_syncs ? 'reliability-failures' : ''}>
                        {count(row.failed_syncs)} failed
                      </strong>
                      <small>{count(row.completed_syncs)} completed</small>
                    </td>
                    <td data-label="Latest failed job">
                      {row.latest_failure_at ? dateTime(row.latest_failure_at) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="research-source-note reliability-footnote">
            Failed jobs are final failures created in this period; pending jobs are excluded. A failed collection may
            later be recovered by another job. Review the CSV sync tab for its latest status.
          </p>
        </>
      )}
    </section>
  )
}
