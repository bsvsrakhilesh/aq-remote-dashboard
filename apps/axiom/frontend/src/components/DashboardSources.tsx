import { useState } from 'react'
import { listTransfers } from '../api'
import { formatIst } from '../india-time'
import type { TransferSource } from '../types'

export function DashboardSources({ disabled, onChoose }: {
  disabled: boolean
  onChoose: (id: string) => void
}) {
  const [files, setFiles] = useState<TransferSource[] | null>(null)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setFiles(await listTransfers())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open the dashboard archive.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div className="dashboard-sources">
      <button className="button secondary" type="button" disabled={disabled || loading} onClick={() => void load()}>
        {loading ? 'Loading archive…' : files ? 'Refresh dashboard archive' : 'Browse dashboard archive'}
      </button>
      {files?.length ? (
        <>
          <label>Dashboard snapshot <select value={selected} onChange={(event) => setSelected(event.target.value)}>
            <option value="">Select a file</option>
            {files.map((file) => (
              <option key={file.job_id} value={file.job_id}>
                {file.device} · {file.filename} · {file.kind === 'raw' ? 'SD snapshot' : 'Minute averages'} · {formatIst(file.captured_at)}
              </option>
            ))}
          </select></label>
          <button className="button secondary" type="button" disabled={disabled || !selected}
            onClick={() => onChoose(selected)}>Use selected file</button>
        </>
      ) : files && <p>No files have been received from the dashboard.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  )
}
