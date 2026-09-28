export interface FleetReliabilityRow {
  device_id: string
  expected_snapshots: number
  reported_snapshots: number
  expected_minutes: number
  recorded_minutes: number
  failed_syncs: number
  completed_syncs: number
  latest_failure_at: string | null
  retention_days: number | null
}

export function coverage(received: number, expected: number): number | null {
  if (expected <= 0) return null
  return Math.min(100, Math.max(0, (received / expected) * 100))
}

export function summarizeReliability(rows: FleetReliabilityRow[]) {
  const total = rows.reduce(
    (sum, row) => ({
      expectedSnapshots: sum.expectedSnapshots + row.expected_snapshots,
      reportedSnapshots: sum.reportedSnapshots + row.reported_snapshots,
      expectedMinutes: sum.expectedMinutes + row.expected_minutes,
      recordedMinutes: sum.recordedMinutes + row.recorded_minutes,
      failedSyncs: sum.failedSyncs + row.failed_syncs,
      completedSyncs: sum.completedSyncs + row.completed_syncs,
      eligibleDevices: sum.eligibleDevices + (row.expected_snapshots > 0 ? 1 : 0),
    }),
    {
      expectedSnapshots: 0,
      reportedSnapshots: 0,
      expectedMinutes: 0,
      recordedMinutes: 0,
      failedSyncs: 0,
      completedSyncs: 0,
      eligibleDevices: 0,
    },
  )
  return {
    ...total,
    reportingCoverage: coverage(total.reportedSnapshots, total.expectedSnapshots),
    minuteCoverage: coverage(total.recordedMinutes, total.expectedMinutes),
  }
}

export function demoReliability(deviceIds: string[], days: 7 | 30): FleetReliabilityRow[] {
  const rates = days === 7 ? [0.986, 0.958, 0.742, 0.998] : [0.977, 0.944, 0.811, 0.991]
  const minuteRates = days === 7 ? [0.979, 0.913, 0.682, 0.995] : [0.966, 0.902, 0.774, 0.988]
  return deviceIds.map((id, index) => ({
    device_id: id,
    expected_snapshots: days * 288,
    reported_snapshots: Math.round(days * 288 * rates[index % rates.length]),
    expected_minutes: days * 1440,
    recorded_minutes: Math.round(days * 1440 * minuteRates[index % minuteRates.length]),
    failed_syncs: index === 2 ? 3 : index === 1 ? 1 : 0,
    completed_syncs: days * 2 - (index === 2 ? 3 : index === 1 ? 1 : 0),
    latest_failure_at: index === 1 || index === 2 ? new Date(Date.now() - (index + 1) * 86400000).toISOString() : null,
    retention_days: null,
  }))
}
