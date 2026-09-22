import { format, formatDistanceStrict } from 'date-fns'
import type { DeviceState, DownloadStatus, RangeKey } from '../types'

export const getDeviceState = (lastSeen: string, now = new Date()): DeviceState => {
  const minutes = (now.getTime() - new Date(lastSeen).getTime()) / 60000
  return minutes <= 2 ? 'online' : minutes <= 10 ? 'stale' : 'offline'
}
export const formatRelative = (value: string, now = new Date()) => formatDistanceStrict(new Date(value), now, { addSuffix: true })
export const formatDateTime = (value: string) => format(new Date(value), 'dd MMM yyyy, HH:mm:ss')
export const formatFileSize = (bytes: number) => {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`
}
export const rssiQuality = (rssi: number) => rssi >= -60 ? 'Excellent' : rssi >= -70 ? 'Good' : rssi >= -80 ? 'Weak' : 'Very weak'
export const rangeHours: Record<RangeKey, number> = { '6h': 6, '24h': 24, '7d': 168, '30d': 720 }
export const isDownloadTransitionValid = (from: DownloadStatus, to: DownloadStatus) => {
  const paths: Record<DownloadStatus, DownloadStatus[]> = { queued: ['device_acknowledged', 'failed', 'expired'], device_acknowledged: ['uploading', 'failed', 'expired'], uploading: ['ready', 'failed', 'expired'], ready: ['expired'], failed: [], expired: [] }
  return paths[from].includes(to)
}
export const downloadLabel: Record<DownloadStatus, string> = { queued: 'Waiting for logger', device_acknowledged: 'Device acknowledged', uploading: 'Uploading from SD card', ready: 'File ready', failed: 'Transfer failed', expired: 'Link expired' }
