import { Database, Download, FileText, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DownloadModal } from '../components/DownloadModal'
import { useAllFiles } from '../hooks/useData'
import { usePreferences } from '../hooks/usePreferences'
import { readOnlyMode } from '../services/supabase'
import type { DeviceFile } from '../types'
import { formatDateTime, formatFileSize, getDeviceState } from '../utils'

export function FilesPage() {
  const [query, setQuery] = useState('')
  const [deviceFilter, setDeviceFilter] = useState('all')
  const [selected, setSelected] = useState<{ file: DeviceFile; code: string; id: string } | null>(null)
  const { data, loading, error, reload } = useAllFiles()
  const { preferences } = usePreferences()
  const devices = useMemo(
    () =>
      Array.from(new Map(data.map((row) => [row.device.id, row.device])).values()).sort((a, b) =>
        a.code.localeCompare(b.code),
      ),
    [data],
  )
  const rows = data.filter(
    (row) =>
      (row.file.filename + row.device.name).toLowerCase().includes(query.toLowerCase()) &&
      (deviceFilter === 'all' || row.device.id === deviceFilter),
  )
  const deviceCount = new Set(data.map((row) => row.device.id)).size
  return (
    <div className="page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Temporary transfer centre</span>
          <h1>Data files</h1>
          <p>Browse SD-card catalogs and securely request full-resolution research files.</p>
        </div>
      </section>
      <div className="info-banner">
        <Database />
        <span>
          <strong>Cloud storage is temporary.</strong> Files remain on logger SD cards and are only uploaded when
          requested.
        </span>
      </div>
      {readOnlyMode && <div className="inline-notice">This workspace is read-only. File transfers are disabled.</div>}
      {error && (
        <div className="error-banner">
          Could not load the file catalog. <button onClick={reload}>Retry</button>
        </div>
      )}
      <section className="panel all-files">
        <div className="panel-head">
          <div>
            <h2>Reported files</h2>
            <p>{loading ? 'Loading catalog...' : `${rows.length} files across ${deviceCount} loggers`}</p>
          </div>
          <div className="controls">
            <label className="search">
              <Search size={17} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search files..."
                aria-label="Search files"
              />
            </label>
            <div className="filter-wrap">
              <select
                value={deviceFilter}
                onChange={(event) => setDeviceFilter(event.target.value)}
                aria-label="Filter by logger"
              >
                <option value="all">All loggers</option>
                {devices.map((device) => (
                  <option value={device.id} key={device.id}>
                    {device.code}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <p className="table-scroll-hint">Scroll sideways to see all file details and actions.</p>
        <div className="data-table" role="table" aria-label="Logger data files" tabIndex={0}>
          <div className="table-header" role="row">
            <span role="columnheader">File</span>
            <span role="columnheader">Logger</span>
            <span role="columnheader">Modified</span>
            <span role="columnheader">Size</span>
            <span role="columnheader">Action</span>
          </div>
          {loading && !data.length
            ? Array.from({ length: 6 }, (_, index) => (
                <div className="table-row table-skeleton" key={index}>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              ))
            : rows.map(({ file, device }) => {
                const offline =
                  getDeviceState(device.lastSeen, new Date(), {
                    onlineMinutes: preferences.onlineMinutes,
                    staleMinutes: preferences.staleMinutes,
                  }) === 'offline'
                return (
                  <div className="table-row" role="row" key={file.id}>
                    <span className="file-name-cell" role="cell">
                      <i>
                        <FileText size={17} />
                      </i>
                      <strong>{file.filename}</strong>
                    </span>
                    <span role="cell">
                      {device.code} · {device.name}
                    </span>
                    <span role="cell">{formatDateTime(file.modifiedAt)}</span>
                    <span role="cell">{formatFileSize(file.size)}</span>
                    <button
                      className="button secondary small"
                      disabled={readOnlyMode || offline}
                      onClick={() => setSelected({ file, code: device.code, id: device.id })}
                    >
                      <Download size={15} /> {offline ? 'Offline' : 'Request'}
                    </button>
                  </div>
                )
              })}
        </div>
        {!loading && !rows.length && (
          <div className="empty compact">
            <FileText size={22} />
            <h3>{data.length ? 'No matching files' : 'No files reported'}</h3>
            <p>
              {data.length
                ? 'Try a different search or logger filter.'
                : 'Refresh a logger catalog from its device dashboard.'}
            </p>
          </div>
        )}
      </section>
      {selected && (
        <DownloadModal
          file={selected.file}
          deviceCode={selected.code}
          deviceId={selected.id}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}
