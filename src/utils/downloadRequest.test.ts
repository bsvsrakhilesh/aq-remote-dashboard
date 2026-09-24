import { describe, expect, it } from 'vitest'
import { describeDownloadRequestFailure } from './downloadRequest'

describe('download request failures', () => {
  it('identifies an expired session instead of blaming the logger', () => {
    expect(describeDownloadRequestFailure(401)).toMatch(/session has expired/)
  })
  it('distinguishes a stale file catalog from a command-queue failure', () => {
    expect(describeDownloadRequestFailure(404, 'file_not_found')).toMatch(/Refresh the file list/)
    expect(describeDownloadRequestFailure(500, 'command_failed')).toMatch(/could not be queued/)
  })
  it('reports network and unknown server failures without inventing a logger fault', () => {
    expect(describeDownloadRequestFailure(undefined, undefined, 'network')).toMatch(/Check your connection/)
    expect(describeDownloadRequestFailure(503)).toContain('HTTP 503')
  })
})
