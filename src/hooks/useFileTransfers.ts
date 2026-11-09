import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FleetFile } from './useData'
import { demoMode, supabase } from '../services/supabase'
import type { DownloadStatus } from '../types'
import { describeDownloadRequestFailure } from '../utils/downloadRequest'

export interface FileTransfer {
  key: string
  item: FleetFile
  requestId: string
  status: DownloadStatus | 'requesting'
  progress: number
  url: string
  expiresAt: string
  error: string
}

const transferKey = (item: FleetFile) => `${item.device.id}:${item.file.filename}`

export function useFileTransfers() {
  const [transfers, setTransfers] = useState<FileTransfer[]>([])
  const starting = useRef(new Set<string>())
  const polling = useRef(new Set<string>())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const update = useCallback((key: string, patch: Partial<FileTransfer>, expectedRequestId?: string) => {
    if (!mounted.current) return
    setTransfers((current) =>
      current.map((transfer) =>
        transfer.key === key && (!expectedRequestId || transfer.requestId === expectedRequestId)
          ? { ...transfer, ...patch }
          : transfer,
      ),
    )
  }, [])

  const refresh = useCallback(
    async (key: string, requestId: string) => {
      if (!supabase || polling.current.has(requestId)) return
      polling.current.add(requestId)
      try {
        const { data: row, error } = await supabase
          .from('download_requests')
          .select('status,progress_percent,storage_path,expires_at,error_message')
          .eq('id', requestId)
          .single()
        if (error || !row) {
          update(key, { error: 'Transfer status is temporarily unavailable. Retrying…' }, requestId)
          return
        }
        const status = row.status as DownloadStatus
        const patch: Partial<FileTransfer> = {
          status,
          progress: Number(row.progress_percent ?? 0),
          error: row.error_message ?? '',
        }
        if (status === 'ready' && row.storage_path && row.expires_at) {
          const seconds = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000)
          if (seconds <= 0) {
            patch.status = 'expired'
            patch.error = 'The temporary link has expired. Request the file again.'
          } else {
            const { data: signed, error: signError } = await supabase.storage
              .from('temporary-downloads')
              .createSignedUrl(row.storage_path, seconds)
            if (signed) {
              patch.url = signed.signedUrl
              patch.expiresAt = row.expires_at
            }
            if (signError || !signed?.signedUrl) {
              patch.error = 'Could not create the download link. Request a fresh copy.'
              patch.expiresAt = row.expires_at
              patch.url = ''
            }
          }
        }
        update(key, patch, requestId)
      } catch {
        update(key, { error: 'Transfer status is temporarily unavailable. Retrying…' }, requestId)
      } finally {
        polling.current.delete(requestId)
      }
    },
    [update],
  )

  useEffect(() => {
    const timer = window.setInterval(() => {
      transfers
        .filter(
          (transfer) =>
            transfer.requestId &&
            !['failed', 'expired'].includes(transfer.status) &&
            (transfer.status !== 'ready' || !transfer.url),
        )
        .forEach((transfer) => void refresh(transfer.key, transfer.requestId))
    }, 10000)
    return () => window.clearInterval(timer)
  }, [refresh, transfers])

  const requestFiles = useCallback(
    (items: FleetFile[], refreshReady = false) => {
      if (!demoMode && !supabase) return
      const activeKeys = new Set(
        transfers
          .filter(
            (transfer) =>
              !['failed', 'expired'].includes(transfer.status) &&
              !(
                transfer.status === 'ready' &&
                ((transfer.expiresAt && new Date(transfer.expiresAt).getTime() <= Date.now()) ||
                  (!transfer.url && transfer.error))
              ),
          )
          .map((transfer) => transfer.key),
      )
      const accepted = items.filter((item) => {
        const key = transferKey(item)
        if (starting.current.has(key) || activeKeys.has(key)) return false
        starting.current.add(key)
        return true
      })
      if (!accepted.length) return
      setTransfers((current) => {
        const next = [...current]
        for (const item of accepted) {
          const key = transferKey(item)
          const existing = next.findIndex((transfer) => transfer.key === key)
          const transfer: FileTransfer = {
            key,
            item,
            requestId: '',
            status: 'requesting',
            progress: 0,
            url: '',
            expiresAt: '',
            error: '',
          }
          if (existing >= 0) next[existing] = transfer
          else next.unshift(transfer)
        }
        return next
      })
      for (const item of accepted) {
        const key = transferKey(item)
        void (async () => {
          try {
            if (demoMode) {
              update(key, {
                status: 'ready',
                progress: 100,
                url: `data:text/csv;charset=utf-8,${encodeURIComponent('timestamp,pm25\n2026-09-22T16:20:00+05:30,18.4\n')}`,
                expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
              })
              return
            }
            const client = supabase!
            const invoke = () =>
              client.functions.invoke('request-file-download', {
                body: { device_id: item.device.id, filename: item.file.filename, refresh_ready: refreshReady },
              })
            let { data, error } = await invoke()
            if (error instanceof FunctionsHttpError && error.context.status === 401) {
              const { error: refreshError } = await client.auth.refreshSession()
              if (!refreshError) ({ data, error } = await invoke())
            }
            if (error || !data?.request_id) {
              let code: string | undefined
              if (error instanceof FunctionsHttpError) {
                const body = await error.context
                  .clone()
                  .json()
                  .catch(() => null)
                if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
                  code = body.error
              }
              update(key, {
                status: 'failed',
                error: describeDownloadRequestFailure(
                  error instanceof FunctionsHttpError ? error.context.status : undefined,
                  code,
                  error instanceof FunctionsFetchError
                    ? 'network'
                    : error instanceof FunctionsRelayError
                      ? 'relay'
                      : undefined,
                ),
              })
              return
            }
            update(key, { requestId: data.request_id, status: data.status ?? 'queued' })
            await refresh(key, data.request_id)
          } catch {
            update(key, { status: 'failed', error: 'Could not start the transfer. Please retry.' })
          } finally {
            starting.current.delete(key)
          }
        })()
      }
    },
    [refresh, transfers, update],
  )

  const cancel = useCallback(
    async (key: string, requestId: string) => {
      if (!supabase || !requestId) return
      try {
        const { error } = await supabase.functions.invoke('cancel-file-download', { body: { request_id: requestId } })
        update(
          key,
          error
            ? { error: 'Could not cancel this transfer. Please retry.' }
            : { status: 'expired', error: 'Cancelled', url: '' },
          requestId,
        )
      } catch {
        update(key, { error: 'Could not cancel this transfer. Please retry.' }, requestId)
      }
    },
    [update],
  )
  const dismiss = useCallback((key: string) => {
    setTransfers((current) => current.filter((transfer) => transfer.key !== key))
  }, [])

  return { transfers, requestFiles, cancel, dismiss }
}
