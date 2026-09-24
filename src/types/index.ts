export type DeviceState = 'online' | 'stale' | 'offline'
export type RangeKey = '6h' | '24h' | '7d' | '30d'
export type DownloadStatus = 'queued' | 'device_acknowledged' | 'uploading' | 'ready' | 'failed' | 'expired'

export interface Reading {
  timestamp: string
  pm25: number | null
  pm10: number | null
  temperature: number | null
  rh: number | null
  co2: number | null
}
export interface Device {
  id: string
  code: string
  name: string
  location: string
  firmware: string
  lastSeen: string
  rssi: number
  co2Enabled: boolean
  installedSensors: string[]
  health: { sd: boolean; sps30: boolean; sht3x: boolean; rtc: boolean; scd30: boolean | null }
  latest: Reading
  currentFilename: string
  currentFileSize: number
}
export interface DeviceFile {
  id: string
  filename: string
  size: number
  modifiedAt: string
}
export interface DownloadRequest {
  id: string
  filename: string
  size: number
  status: DownloadStatus
  progress: number
  expiresAt?: string
}
