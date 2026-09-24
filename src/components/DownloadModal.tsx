import { AlertTriangle, CheckCircle2, Download, FileText, LoaderCircle, X } from 'lucide-react'
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { useEffect, useMemo, useRef, useState } from 'react'
import { demoMode, supabase } from '../services/supabase'
import type { DeviceFile, DownloadStatus } from '../types'
import { downloadLabel, formatFileSize } from '../utils'
import { describeDownloadRequestFailure } from '../utils/downloadRequest'

interface Props {
  file: DeviceFile
  deviceCode: string
  deviceId: string
  onClose: () => void
}

export function DownloadModal({ file, deviceCode, deviceId, onClose }: Props) {
  const [requestId, setRequestId] = useState('')
  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState<DownloadStatus>('queued')
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [now, setNow] = useState(Date.now())
  const modalRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.body.style.overflow
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    document.body.style.overflow = 'hidden'
    modalRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'Tab') {
        const elements = modalRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled)',
        )
        if (!elements?.length) return
        const first = elements[0]
        const last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    window.addEventListener('keydown', escape)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', escape)
      trigger?.focus({ preventScroll: true })
    }
  }, [onClose])
  useEffect(() => {
    if (!expiresAt) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [expiresAt])
  const countdown = useMemo(() => {
    if (!expiresAt) return ''
    const seconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - now) / 1000))
    return `${Math.floor(seconds / 60)
      .toString()
      .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
  }, [expiresAt, now])
  useEffect(() => {
    if (demoMode) {
      const timer = window.setInterval(
        () =>
          setProgress((current) => {
            const next = Math.min(100, current + Math.ceil(Math.random() * 9))
            setStatus(next === 100 ? 'ready' : next > 8 ? 'uploading' : next > 0 ? 'device_acknowledged' : 'queued')
            if (next === 100) {
              setExpiresAt(new Date(Date.now() + 15 * 60 * 1000).toISOString())
              setUrl(
                `data:text/csv;charset=utf-8,${encodeURIComponent('timestamp,pm25,pm10,temperature_c,rh\n2026-09-22T16:20:00+05:30,18.4,31.2,26.4,58.0\n')}`,
              )
              window.clearInterval(timer)
            }
            return next
          }),
        650,
      )
      return () => window.clearInterval(timer)
    }
    if (!supabase) return
    const client = supabase
    let active = true
    let poll = 0
    let polling = true
    void (async () => {
      const invoke = () =>
        client.functions.invoke('request-file-download', {
          body: { device_id: deviceId, filename: file.filename },
        })
      let { data, error: requestError } = await invoke()
      if (requestError instanceof FunctionsHttpError && requestError.context.status === 401) {
        const { error: refreshError } = await client.auth.refreshSession()
        if (!refreshError) ({ data, error: requestError } = await invoke())
      }
      if (!active) return
      if (requestError || !data?.request_id) {
        let code: string | undefined
        if (requestError instanceof FunctionsHttpError) {
          const payload = await requestError.context
            .clone()
            .json()
            .catch(() => null)
          if (payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string')
            code = payload.error
        }
        if (!active) return
        setStatus('failed')
        setError(
          describeDownloadRequestFailure(
            requestError instanceof FunctionsHttpError ? requestError.context.status : undefined,
            code,
            requestError instanceof FunctionsFetchError
              ? 'network'
              : requestError instanceof FunctionsRelayError
                ? 'relay'
                : undefined,
          ),
        )
        return
      }
      setRequestId(data.request_id)
      const check = async () => {
        const { data: row, error: pollError } = await client
          .from('download_requests')
          .select('status,progress_percent,storage_path,expires_at,error_message')
          .eq('id', data.request_id)
          .single()
        if (!active) return
        if (pollError) {
          setError('Transfer status is temporarily unavailable. Close this window and retry from the file list.')
          polling = false
          window.clearInterval(poll)
          return
        }
        const nextStatus = row.status as DownloadStatus
        setStatus(nextStatus)
        setProgress(row.progress_percent)
        if (row.error_message) setError(row.error_message)
        if (['failed', 'expired'].includes(nextStatus)) {
          polling = false
          window.clearInterval(poll)
        }
        if (nextStatus === 'ready' && row.storage_path && row.expires_at) {
          setExpiresAt(row.expires_at)
          const seconds = Math.max(1, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000))
          const { data: signed, error: signError } = await client.storage
            .from('temporary-downloads')
            .createSignedUrl(row.storage_path, seconds)
          if (signed) setUrl(signed.signedUrl)
          if (signError) setError('The secure download link could not be created. Retry the request.')
          polling = false
          window.clearInterval(poll)
        }
      }
      await check()
      if (active && polling) poll = window.setInterval(() => void check(), 2000)
    })()
    return () => {
      active = false
      window.clearInterval(poll)
    }
  }, [deviceId, file.filename])
  const cancel = async () => {
    if (!demoMode && supabase && requestId)
      await supabase.functions.invoke('cancel-file-download', { body: { request_id: requestId } })
    onClose()
  }
  const terminal = status === 'failed' || status === 'expired'
  const Icon = status === 'ready' ? CheckCircle2 : terminal ? AlertTriangle : FileText
  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="download-title">
      <div className="modal" ref={modalRef}>
        <button className="modal-close icon-btn" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <div className={`modal-icon ${status === 'ready' ? 'success' : terminal ? 'failure' : ''}`}>
          <Icon />
        </div>
        <span className="eyebrow">Secure temporary transfer</span>
        <h2 id="download-title">
          {status === 'ready' ? 'Your file is ready' : terminal ? 'Transfer unavailable' : 'Retrieving data file'}
        </h2>
        <p>
          {status === 'ready'
            ? 'Download before the private link expires.'
            : terminal
              ? requestId
                ? 'The logger could not complete this request.'
                : 'The transfer request could not be started.'
              : 'Keep this window open while the logger streams directly from its SD card.'}
        </p>
        <div className="file-summary">
          <div>
            <small>Device</small>
            <strong>{deviceCode}</strong>
          </div>
          <div>
            <small>File</small>
            <strong>{file.filename}</strong>
          </div>
          <div>
            <small>Size</small>
            <strong>{formatFileSize(file.size)}</strong>
          </div>
        </div>
        <div className="progress-copy">
          <span>
            {!terminal && status !== 'ready' && <LoaderCircle className="spin" size={15} />} {downloadLabel[status]}
          </span>
          <strong>{progress}%</strong>
        </div>
        <div className="progress">
          <span style={{ width: `${progress}%` }} />
        </div>
        {error && (
          <div className="auth-error" role="alert">
            {error}
          </div>
        )}
        {status === 'ready' ? (
          <>
            <a className={`button primary full ${url ? '' : 'disabled'}`} href={url || undefined} download>
              <Download size={17} /> {url ? 'Download CSV' : 'Preparing secure link...'}
            </a>
            <div className="expiry">
              Temporary file expires in <strong>{countdown}</strong>
            </div>
          </>
        ) : terminal ? (
          <button className="button secondary full" onClick={onClose}>
            Close
          </button>
        ) : (
          <button className="button secondary full" onClick={() => void cancel()}>
            Cancel transfer
          </button>
        )}
        <div className="security-note">Encrypted in transit · Automatically deleted after expiry</div>
      </div>
    </div>
  )
}
