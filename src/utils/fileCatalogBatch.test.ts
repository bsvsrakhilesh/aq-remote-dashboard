import { describe, expect, it } from 'vitest'
import { summarizeFleetCatalogBatch, updateFleetCatalogBatch, type FleetCatalogBatch } from './fileCatalogBatch'

const batch: FleetCatalogBatch = {
  startedAt: 0,
  items: [
    { deviceId: 'one', code: 'aq_indoor01', commandId: 'command-one', status: 'queued', errorMessage: null },
    { deviceId: 'two', code: 'aq_indoor02', commandId: 'command-two', status: 'acknowledged', errorMessage: null },
    {
      deviceId: 'three',
      code: 'aq_indoor03',
      commandId: null,
      status: 'request_failed',
      errorMessage: 'Network error',
    },
  ],
}

describe('fleet file-list refresh', () => {
  it('waits until every queued logger reaches a terminal status', () => {
    const partlyDone = updateFleetCatalogBatch(
      batch,
      [{ commandId: 'command-one', status: 'completed', errorMessage: null }],
      1000,
    )
    expect(summarizeFleetCatalogBatch(partlyDone)).toMatchObject({ completed: 1, pending: 1 })
    const done = updateFleetCatalogBatch(
      partlyDone,
      [{ commandId: 'command-two', status: 'failed', errorMessage: 'SD card unavailable' }],
      2000,
    )
    expect(summarizeFleetCatalogBatch(done)).toMatchObject({ total: 3, completed: 1, pending: 0 })
    expect(done.items[1].errorMessage).toBe('SD card unavailable')
  })

  it('reports a nonresponding logger after the command window without changing successful results', () => {
    const updated = updateFleetCatalogBatch(
      batch,
      [{ commandId: 'command-one', status: 'completed', errorMessage: null }],
      6 * 60 * 60 * 1000,
    )
    expect(updated.items.map((item) => item.status)).toEqual(['completed', 'timed_out', 'request_failed'])
    expect(summarizeFleetCatalogBatch(updated).pending).toBe(0)
  })
})
