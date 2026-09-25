import { useCallback, useEffect, useState } from 'react'
import { demoMode, supabase } from '../services/supabase'
import { collectTelemetryPages } from '../services/telemetry'
import { closedSyncWindow, istDayStart, type MinuteReading } from '../utils/minuteHistory'

interface Sync {
  last_imported_at: string
  latest_minute: string
  source_filename: string
  imported_minutes: number
}
interface Job {
  status: 'queued' | 'waiting' | 'processing' | 'completed' | 'failed'
  filename: string
  error_message: string | null
  completed_at: string | null
  imported_minutes: number | null
  skipped_rows: number | null
  source_bytes: number | null
  hour_end: string
}
interface Row {
  timestamp: string
  pm1: number | null
  pm25: number | null
  pm10: number | null
  temperature_c: number | null
  rh: number | null
  co2_ppm: number | null
  sample_count: number
  valid_counts: number[]
}

export function useMinuteHistory(deviceId: string | undefined, date: string, co2Enabled: boolean) {
  const [rows, setRows] = useState<MinuteReading[]>([])
  const [sync, setSync] = useState<Sync | null>(null)
  const [job, setJob] = useState<Job | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    if (!deviceId) return
    let alive = true
    setSync(null)
    setJob(null)
    const load = async () => {
      if (demoMode) {
        const latest = new Date(closedSyncWindow() - 60000).toISOString()
        setSync({
          last_imported_at: new Date(Math.min(Date.now(), closedSyncWindow() + 120000)).toISOString(),
          latest_minute: latest,
          source_filename: 'Demo weekly CSV',
          imported_minutes: 60,
        })
        setJob({
          status: 'completed',
          filename: 'Demo weekly CSV',
          hour_end: new Date(closedSyncWindow()).toISOString(),
          error_message: null,
          completed_at: latest,
          imported_minutes: 60,
          skipped_rows: 0,
          source_bytes: 284800,
        })
        return
      }
      if (!supabase) return
      const [settings, synced, jobs] = await Promise.all([
        supabase.from('csv_history_settings').select('enabled').eq('device_id', deviceId).maybeSingle(),
        supabase.from('minute_history_sync').select('*').eq('device_id', deviceId).maybeSingle(),
        supabase
          .from('csv_history_jobs')
          .select('status,filename,error_message,completed_at,imported_minutes,skipped_rows,source_bytes,hour_end')
          .eq('device_id', deviceId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (!alive) return
      if (settings.error || synced.error || jobs.error) {
        setStatusError('CSV sync status could not be loaded. Please retry.')
        return
      }
      setStatusError(null)
      setEnabled(settings.data?.enabled ?? true)
      setSync(synced.data as Sync | null)
      setJob(jobs.data as Job | null)
    }
    void load().catch(() => {
      if (alive) setStatusError('CSV sync status could not be loaded. Please retry.')
    })
    const timer = window.setInterval(() => {
      void load().catch(() => {
        if (alive) setStatusError('CSV sync status could not be loaded. Please retry.')
      })
    }, 30000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [deviceId, version])

  useEffect(() => {
    if (!deviceId) return
    let alive = true
    setLoading(true)
    setError(null)
    setRows([])
    const start = istDayStart(date)
    if (demoMode) {
      const demo: MinuteReading[] = []
      for (let time = start, index = 0; time < Math.min(start + 86400000, closedSyncWindow()); time += 60000, index++) {
        if (index % 180 >= 170) continue
        const wave = Math.sin(index / 30)
        demo.push({
          timestamp: new Date(time).toISOString(),
          pm1: 12 + 3 * wave,
          pm25: 18 + 4 * wave,
          pm10: 25 + 5 * wave,
          temperature: 25 + wave,
          rh: 55 + 8 * wave,
          co2: co2Enabled ? 650 + 100 * wave : null,
          sampleCount: 30,
          validCounts: [30, 30, 30, 30, 30, co2Enabled ? 30 : 0],
        })
      }
      setRows(demo)
      setLoading(false)
      return
    }
    const client = supabase
    if (!client) return
    void collectTelemetryPages<Row>(async (from, to) => {
      if (!alive) return []
      const { data, error: queryError } = await client
        .from('telemetry_1min')
        .select('timestamp,pm1,pm25,pm10,temperature_c,rh,co2_ppm,sample_count,valid_counts')
        .eq('device_id', deviceId)
        .gte('timestamp', new Date(start).toISOString())
        .lt('timestamp', new Date(start + 86400000).toISOString())
        .order('timestamp')
        .range(from, to)
      if (queryError) throw queryError
      return (data ?? []) as Row[]
    })
      .then((data) => {
        if (alive)
          setRows(
            data.map((row) => ({
              timestamp: row.timestamp,
              pm1: row.pm1,
              pm25: row.pm25,
              pm10: row.pm10,
              temperature: row.temperature_c,
              rh: row.rh,
              co2: row.co2_ppm,
              sampleCount: row.sample_count,
              validCounts: row.valid_counts,
            })),
          )
      })
      .catch(() => {
        if (alive) setError('One-minute history could not be loaded. Please retry.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [deviceId, date, co2Enabled, sync?.last_imported_at, version])

  const toggle = async () => {
    if (!deviceId || saving) return
    setSaving(true)
    try {
      if (!demoMode && supabase) {
        const { data, error: saveError } = await supabase
          .from('csv_history_settings')
          .update({ enabled: !enabled })
          .eq('device_id', deviceId)
          .select('enabled')
          .single()
        if (saveError || !data) throw new Error('Could not change the CSV schedule. Please retry.')
      }
      setEnabled(!enabled)
      setStatusError(null)
    } catch {
      setStatusError('Could not change the CSV schedule. Please retry.')
    } finally {
      setSaving(false)
    }
  }
  return { rows, sync, job, enabled, loading, saving, error: error ?? statusError, reload, toggle }
}
