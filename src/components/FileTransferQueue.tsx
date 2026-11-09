import { Download, LoaderCircle, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { FileTransfer } from '../hooks/useFileTransfers'
import { downloadLabel, formatFileSize } from '../utils'

interface Props {
  transfers: FileTransfer[]
  onCancel: (key: string, requestId: string) => void
  onDismiss: (key: string) => void
  onRetry: (transfer: FileTransfer) => void
}

export function FileTransferQueue({ transfers, onCancel, onDismiss, onRetry }: Props) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (!transfers.length) return null
  return (
    <section className="panel transfer-panel" aria-label="File transfers">
      <div className="panel-head">
        <div>
          <h2>File transfers</h2>
          <p>
            Each logger uploads one file at a time. Requests for different loggers can run together. Keep this page open
            to watch progress.
          </p>
        </div>
      </div>
      <div className="transfer-list">
        {transfers.map((transfer) => {
          const expiredLink =
            transfer.status === 'ready' && !!transfer.expiresAt && new Date(transfer.expiresAt).getTime() <= now
          const linkUnavailable = transfer.status === 'ready' && !transfer.url && !!transfer.error
          const terminal = ['failed', 'expired'].includes(transfer.status) || expiredLink || linkUnavailable
          const label =
            transfer.status === 'requesting'
              ? 'Sending request'
              : expiredLink || linkUnavailable
                ? 'Download link unavailable'
                : downloadLabel[transfer.status]
          return (
            <div className="transfer-item" key={transfer.key}>
              <div className="transfer-item-head">
                <div>
                  <strong>{transfer.item.file.filename}</strong>
                  <span>
                    {transfer.item.device.code} · {formatFileSize(transfer.item.file.size)}
                  </span>
                </div>
                {(terminal || transfer.status === 'ready') && (
                  <button
                    className="icon-btn"
                    aria-label={`Dismiss ${transfer.item.file.filename} from ${transfer.item.device.code}`}
                    onClick={() => onDismiss(transfer.key)}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <div className="progress-copy" role="status">
                <span>
                  {!terminal && transfer.status !== 'ready' && <LoaderCircle className="spin" size={15} />}
                  {label}
                </span>
                <strong>{transfer.progress}%</strong>
              </div>
              <div className="progress" aria-label={`${transfer.progress}% uploaded`}>
                <span style={{ width: `${transfer.progress}%` }} />
              </div>
              {transfer.error && (
                <p className="transfer-error" role="alert">
                  {transfer.error}
                </p>
              )}
              <div className="transfer-actions">
                {transfer.status === 'ready' && !terminal && transfer.url && (
                  <a className="button primary small" href={transfer.url} download={transfer.item.file.filename}>
                    <Download size={15} /> Download CSV
                  </a>
                )}
                {terminal && (
                  <button className="button secondary small" onClick={() => onRetry(transfer)}>
                    Request again
                  </button>
                )}
                {!terminal && transfer.status !== 'ready' && (
                  <button
                    className="button secondary small"
                    disabled={!transfer.requestId}
                    onClick={() => onCancel(transfer.key, transfer.requestId)}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
