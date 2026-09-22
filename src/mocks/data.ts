import type { Device, DeviceFile, RangeKey, Reading } from '../types'
import { rangeHours } from '../utils'

const now = Date.now()
const isoAgo = (minutes: number) => new Date(now - minutes * 60000).toISOString()
export const devices: Device[] = [
  { id: '01', code: 'AQ01', name: 'Main Gate', location: 'IIT Delhi · Gate 1', firmware: 'v1.3.2', lastSeen: isoAgo(.3), rssi: -57, health: { sd: true, sps30: true, sht3x: true, rtc: true }, latest: { timestamp: isoAgo(2), pm25: 18.4, pm10: 31.2, temperature: 26.4, rh: 58 }, currentFilename: 'AQ01_2026-09-22.csv', currentFileSize: 18634259 },
  { id: '02', code: 'AQ02', name: 'Block V Rooftop', location: 'IIT Delhi · Block V', firmware: 'v1.3.2', lastSeen: isoAgo(1.2), rssi: -68, health: { sd: true, sps30: true, sht3x: true, rtc: true }, latest: { timestamp: isoAgo(3), pm25: 24.8, pm10: 38.6, temperature: 28.1, rh: 54 }, currentFilename: 'AQ02_2026-09-22.csv', currentFileSize: 20188421 },
  { id: '03', code: 'AQ03', name: 'Laboratory Annex', location: 'IIT Delhi · CRDT', firmware: 'v1.2.9', lastSeen: isoAgo(47), rssi: -91, health: { sd: true, sps30: false, sht3x: true, rtc: true }, latest: { timestamp: isoAgo(49), pm25: 14.2, pm10: 22.7, temperature: 25.8, rh: 61 }, currentFilename: 'AQ03_2026-09-22.csv', currentFileSize: 17430204 },
  { id: '04', code: 'AQ04', name: 'Transit Corridor', location: 'IIT Delhi · Eastern Avenue', firmware: 'v1.3.1', lastSeen: isoAgo(6), rssi: -79, health: { sd: true, sps30: true, sht3x: true, rtc: true }, latest: { timestamp: isoAgo(7), pm25: 32.1, pm10: 48.9, temperature: 29.2, rh: 49 }, currentFilename: 'AQ04_2026-09-22.csv', currentFileSize: 19325440 },
]
export const filesFor = (code: string): DeviceFile[] => [0, 1, 2, 3, 4].map((day) => ({ id: `${code}-${day}`, filename: `${code}_2026-09-${String(22 - day).padStart(2, '0')}.csv`, size: 18634259 + day * 975421, modifiedAt: new Date(now - day * 86400000).toISOString() }))

export function telemetryFor(device: Device, range: RangeKey): Reading[] {
  const hours = rangeHours[range]; const points = Math.min(Math.floor(hours * 12), 360); const step = (hours * 60) / points
  return Array.from({ length: points }, (_, index) => {
    const phase = index / 13 + Number(device.id); const trend = Math.sin(phase) * 4 + Math.cos(index / 29) * 2
    const gap = index % 79 === 34
    return { timestamp: isoAgo((points - index) * step), pm25: gap ? null : +(device.latest.pm25! + trend).toFixed(1), pm10: gap ? null : +(device.latest.pm10! + trend * 1.35).toFixed(1), temperature: gap ? null : +(device.latest.temperature! + Math.sin(index / 31) * 1.8).toFixed(1), rh: gap ? null : +(device.latest.rh! + Math.cos(index / 23) * 5).toFixed(1) }
  })
}
