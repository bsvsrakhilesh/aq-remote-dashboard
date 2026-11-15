import type { Device, DeviceState } from '../types'
import { getDeviceState } from './index'

export interface DeviceIssue {
  id: string
  label: string
  detail: string
  severity: 'critical' | 'warning' | 'advisory'
}

export interface DeviceAssessment {
  state: DeviceState
  issues: DeviceIssue[]
}

const hasMeasurement = (device: Device) =>
  [
    device.latest.pm1,
    device.latest.pm25,
    device.latest.pm10,
    device.latest.temperature,
    device.latest.rh,
    device.latest.co2,
  ].some((value) => value !== null && Number.isFinite(value))

/** Browser-side triage from fields already reported to the cloud; no logger command is sent. */
export function assessDevice(
  device: Device,
  now = new Date(),
  thresholds = { onlineMinutes: 20, staleMinutes: 40 },
): DeviceAssessment {
  const state = getDeviceState(device.lastSeen, now, thresholds)
  const issues: DeviceIssue[] = []
  if (state === 'offline')
    issues.push({ id: 'contact', label: 'Offline', detail: 'No recent cloud contact', severity: 'critical' })
  else if (state === 'stale')
    issues.push({
      id: 'contact',
      label: 'Contact delayed',
      detail: 'Heartbeat is later than expected',
      severity: 'warning',
    })

  if (!device.health.sd)
    issues.push({
      id: 'sd',
      label: 'SD check',
      detail: 'Logger has not reported a healthy SD card',
      severity: 'critical',
    })
  if (/\.csv$/i.test(device.currentFilename) && device.currentFileSize === 0)
    issues.push({
      id: 'csv',
      label: 'Active CSV · 0 B',
      detail: 'Reported file size is 0 B; verify SD writes',
      severity: 'warning',
    })

  if (device.installedSensors.includes('sps30') && !device.health.sps30)
    issues.push({ id: 'sps30', label: 'Particle sensor', detail: 'SPS30 check needs review', severity: 'warning' })
  if (device.installedSensors.includes('sht3x') && !device.health.sht3x)
    issues.push({ id: 'sht3x', label: 'Temperature sensor', detail: 'SHT3x check needs review', severity: 'warning' })
  if (device.installedSensors.includes('scd30') && device.health.scd30 === false)
    issues.push({ id: 'scd30', label: 'CO₂ sensor', detail: 'SCD30 check needs review', severity: 'warning' })

  if (!hasMeasurement(device))
    issues.push({
      id: 'telemetry',
      label: 'No measurements',
      detail: 'No usable cloud reading is available',
      severity: 'warning',
    })
  else if (state === 'online' && now.getTime() - Date.parse(device.latest.timestamp) > 35 * 60_000)
    issues.push({
      id: 'telemetry',
      label: 'Readings delayed',
      detail: 'Latest cloud reading is over 35 minutes old',
      severity: 'warning',
    })

  if (state === 'online' && device.rssi < -80)
    issues.push({ id: 'wifi', label: 'Weak Wi-Fi', detail: `${device.rssi} dBm at last contact`, severity: 'advisory' })

  return { state, issues }
}

export function assessmentRank(assessment: DeviceAssessment): number {
  if (assessment.issues.some((issue) => issue.severity === 'critical')) return 0
  if (assessment.issues.some((issue) => issue.severity === 'warning')) return 1
  if (assessment.issues.length) return 2
  return 3
}
