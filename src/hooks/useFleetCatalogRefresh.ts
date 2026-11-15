import { useCallback, useEffect, useState } from 'react'
import { getFileListCommandStatuses } from '../services/fileCatalog'
import {
  summarizeFleetCatalogBatch,
  updateFleetCatalogBatch,
  type FleetCatalogBatch,
  type FleetCatalogItem,
} from '../utils/fileCatalogBatch'

const storageKey = 'aq-fleet-catalog-refresh'
const pollIntervalMs = 30_000

function readSavedBatch(): FleetCatalogBatch | null {
  try {
    const saved = sessionStorage.getItem(storageKey)
    if (!saved) return null
    const batch = JSON.parse(saved) as FleetCatalogBatch
    if (
      !Number.isFinite(batch?.startedAt) ||
      !Array.isArray(batch.items) ||
      batch.items.length > 500 ||
      batch.items.some(
        (item) =>
          typeof item.deviceId !== 'string' ||
          typeof item.code !== 'string' ||
          (item.commandId !== null && typeof item.commandId !== 'string') ||
          typeof item.status !== 'string',
      )
    )
      return null
    return batch
  } catch {
    return null
  }
}

export function useFleetCatalogRefresh() {
  const [batch, setBatch] = useState<FleetCatalogBatch | null>(readSavedBatch)
  const [statusError, setStatusError] = useState<string | null>(null)
  const startBatch = useCallback((items: FleetCatalogItem[]) => {
    setBatch({ startedAt: Date.now(), items })
    setStatusError(null)
  }, [])
  const clearBatch = useCallback(() => {
    setBatch(null)
    setStatusError(null)
  }, [])

  useEffect(() => {
    try {
      if (batch) sessionStorage.setItem(storageKey, JSON.stringify(batch))
      else sessionStorage.removeItem(storageKey)
    } catch {
      // The active tab still tracks completion when session storage is unavailable.
    }
  }, [batch])

  const summary = batch ? summarizeFleetCatalogBatch(batch) : null
  useEffect(() => {
    if (summary?.completed) window.dispatchEvent(new Event('aq-file-catalog-updated'))
  }, [batch?.startedAt, summary?.completed])
  const pendingIds =
    batch?.items
      .filter(
        (item) => item.commandId && !['completed', 'failed', 'expired', 'unknown', 'timed_out'].includes(item.status),
      )
      .map((item) => item.commandId!) ?? []
  const pendingKey = pendingIds.join(',')
  useEffect(() => {
    if (!pendingKey) return
    let alive = true
    let polling = false
    const ids = pendingKey.split(',')
    const check = async () => {
      if (polling || document.visibilityState !== 'visible') return
      polling = true
      try {
        const statuses = await getFileListCommandStatuses(ids)
        if (alive) {
          setBatch((current) => (current ? updateFleetCatalogBatch(current, statuses) : null))
          setStatusError(null)
        }
      } catch {
        if (alive) {
          setBatch((current) => (current ? updateFleetCatalogBatch(current, []) : null))
          setStatusError('Could not check file-list progress. Retrying automatically.')
        }
      } finally {
        polling = false
      }
    }
    void check()
    const timer = window.setInterval(() => void check(), pollIntervalMs)
    document.addEventListener('visibilitychange', check)
    return () => {
      alive = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [pendingKey])

  return { batch, summary, statusError, startBatch, clearBatch }
}

export type FleetCatalogRefreshContext = ReturnType<typeof useFleetCatalogRefresh>
