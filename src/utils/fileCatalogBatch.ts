import type { FileListCommandStatus, FileListStatusResult } from '../services/fileCatalog'

export type FleetCatalogStatus = FileListCommandStatus | 'request_failed' | 'timed_out'

export interface FleetCatalogItem {
  deviceId: string
  code: string
  commandId: string | null
  status: FleetCatalogStatus
  errorMessage: string | null
}

export interface FleetCatalogBatch {
  startedAt: number
  items: FleetCatalogItem[]
}

const terminalStatuses = new Set<FleetCatalogStatus>([
  'completed',
  'failed',
  'expired',
  'unknown',
  'request_failed',
  'timed_out',
])

export function summarizeFleetCatalogBatch(batch: FleetCatalogBatch) {
  const completed = batch.items.filter((item) => item.status === 'completed').length
  const failed = batch.items.filter((item) => terminalStatuses.has(item.status) && item.status !== 'completed')
  return {
    total: batch.items.length,
    completed,
    failed,
    pending: batch.items.length - completed - failed.length,
  }
}

export function updateFleetCatalogBatch(batch: FleetCatalogBatch, statuses: FileListStatusResult[], now = Date.now()) {
  const byId = new Map(statuses.map((item) => [item.commandId, item]))
  return {
    ...batch,
    items: batch.items.map((item) => {
      if (terminalStatuses.has(item.status)) return item
      const result = item.commandId ? byId.get(item.commandId) : undefined
      const status = result?.status ?? item.status
      return {
        ...item,
        status: terminalStatuses.has(status)
          ? status
          : now - batch.startedAt >= 6 * 60 * 60 * 1000
            ? 'timed_out'
            : status,
        errorMessage: result?.errorMessage ?? item.errorMessage,
      }
    }),
  }
}
