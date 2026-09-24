import { describe, expect, it } from 'vitest'
import {
  formatDateTime,
  formatFileCreatedAt,
  formatFileSize,
  getDeviceState,
  isDownloadTransitionValid,
  rangeHours,
  rssiQuality,
  timeZoneLabel,
} from './index'

describe('device status', () => {
  const now = new Date('2026-09-22T12:00:00Z')
  it('uses heartbeat thresholds', () => {
    expect(getDeviceState('2026-09-22T11:59:00Z', now)).toBe('online')
    expect(getDeviceState('2026-09-22T11:55:00Z', now)).toBe('stale')
    expect(getDeviceState('2026-09-22T11:40:00Z', now)).toBe('offline')
  })
  it('honours user-configured heartbeat thresholds', () => {
    expect(getDeviceState('2026-09-22T11:57:00Z', now, { onlineMinutes: 5, staleMinutes: 15 })).toBe('online')
    expect(getDeviceState('2026-09-22T11:48:00Z', now, { onlineMinutes: 5, staleMinutes: 15 })).toBe('stale')
  })
})
describe('formatting', () => {
  it('formats file sizes', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(18634259)).toBe('17.8 MB')
  })
  it('classifies RSSI conservatively', () => {
    expect(rssiQuality(-54)).toBe('Excellent')
    expect(rssiQuality(-68)).toBe('Good')
    expect(rssiQuality(-77)).toBe('Weak')
    expect(rssiQuality(-89)).toBe('Very weak')
  })
  it('formats timestamps', () => expect(formatDateTime('2026-09-22T12:00:00Z')).toMatch(/22 Sep 2026/))
  it('does not invent a file creation date when the logger did not report one', () => {
    expect(formatFileCreatedAt(null)).toBe('Date unavailable')
    expect(formatFileCreatedAt('invalid')).toBe('Date unavailable')
    expect(formatFileCreatedAt('2026-09-22T12:00:00Z')).toMatch(/22 Sep 2026/)
  })
  it('reports the browser time-zone label', () => expect(timeZoneLabel(new Date('2026-09-22T12:00:00Z'))).toBeTruthy())
})
describe('ranges and transfers', () => {
  it('maps graph ranges to hours', () => expect(rangeHours).toEqual({ '6h': 6, '24h': 24, '7d': 168, '30d': 720 }))
  it('rejects invalid transfer transitions', () => {
    expect(isDownloadTransitionValid('queued', 'device_acknowledged')).toBe(true)
    expect(isDownloadTransitionValid('queued', 'ready')).toBe(false)
    expect(isDownloadTransitionValid('ready', 'expired')).toBe(true)
  })
})
