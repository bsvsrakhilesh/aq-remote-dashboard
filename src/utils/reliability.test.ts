import { describe, expect, it } from 'vitest'
import { coverage, summarizeReliability, type FleetReliabilityRow } from './reliability'

const row = (overrides: Partial<FleetReliabilityRow> = {}): FleetReliabilityRow => ({
  device_id: 'device-1',
  expected_snapshots: 100,
  reported_snapshots: 90,
  expected_minutes: 500,
  recorded_minutes: 450,
  failed_syncs: 1,
  completed_syncs: 5,
  latest_failure_at: null,
  retention_days: null,
  ...overrides,
})

describe('fleet reliability', () => {
  it('does not imply coverage before a device has eligible history', () => {
    expect(coverage(0, 0)).toBeNull()
    expect(summarizeReliability([row({ expected_snapshots: 0, expected_minutes: 0 })]).eligibleDevices).toBe(0)
  })

  it('weights the fleet by expected slots instead of averaging device percentages', () => {
    const result = summarizeReliability([
      row(),
      row({
        device_id: 'device-2',
        expected_snapshots: 10,
        reported_snapshots: 0,
        expected_minutes: 10,
        recorded_minutes: 0,
        failed_syncs: 2,
      }),
    ])
    expect(result.reportingCoverage).toBeCloseTo((90 / 110) * 100)
    expect(result.minuteCoverage).toBeCloseTo((450 / 510) * 100)
    expect(result.failedSyncs).toBe(3)
    expect(result.eligibleDevices).toBe(2)
  })

  it('clamps accidental over-counts so a coverage display never exceeds 100%', () => {
    expect(coverage(101, 100)).toBe(100)
  })
})
