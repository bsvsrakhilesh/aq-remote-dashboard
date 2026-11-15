import { describe, expect, it } from 'vitest'
import { devices } from '../mocks/data'
import { assessDevice, assessmentRank } from './deviceInsights'

const now = new Date('2026-11-15T12:00:00.000Z')
const healthy = {
  ...devices[0],
  lastSeen: '2026-11-15T11:56:00.000Z',
  latest: { ...devices[0].latest, timestamp: '2026-11-15T11:50:00.000Z' },
}

describe('fleet attention assessment', () => {
  it('flags an empty active CSV even while the logger is online and its SD check says healthy', () => {
    const assessment = assessDevice({ ...healthy, currentFileSize: 0 }, now)
    expect(assessment.state).toBe('online')
    expect(assessment.issues.map((issue) => issue.id)).toContain('csv')
    expect(assessmentRank(assessment)).toBe(1)
  })

  it('distinguishes an old cloud reading from a recent heartbeat', () => {
    const assessment = assessDevice(
      { ...healthy, latest: { ...healthy.latest, timestamp: '2026-11-15T11:20:00.000Z' } },
      now,
    )
    expect(assessment.issues.map((issue) => issue.id)).toContain('telemetry')
    expect(assessment.issues.map((issue) => issue.id)).not.toContain('contact')
  })

  it('does not claim a healthy logger needs attention', () => {
    expect(assessDevice(healthy, now).issues).toEqual([])
  })
})
