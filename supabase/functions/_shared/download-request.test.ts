import { describe, expect, it } from 'vitest'
import { shouldReuseDownload } from './download-request'

describe('manual download retry', () => {
  const now = Date.parse('2026-11-09T12:00:00Z')

  it('reuses a queued transfer even when the user retries', () => {
    expect(shouldReuseDownload({ status: 'queued', expires_at: null }, true, now)).toBe(true)
  })

  it('reuses a valid ready link during a normal request', () => {
    expect(shouldReuseDownload({ status: 'ready', expires_at: '2026-11-09T12:05:00Z' }, false, now)).toBe(true)
  })

  it('creates a fresh copy when the link expired or the user explicitly retries it', () => {
    expect(shouldReuseDownload({ status: 'ready', expires_at: '2026-11-09T11:59:59Z' }, false, now)).toBe(false)
    expect(shouldReuseDownload({ status: 'ready', expires_at: '2026-11-09T12:05:00Z' }, true, now)).toBe(false)
  })
})
