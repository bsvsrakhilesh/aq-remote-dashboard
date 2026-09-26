import { useCallback, useEffect, useState } from 'react'
import { demoMode, supabase } from '../services/supabase'
import { devices } from '../mocks/data'
import { metrics, researchWindow, type ResearchConfig, type SeriesRow } from '../utils/research'

export function useResearch(config: ResearchConfig) {
  const [rows, setRows] = useState<SeriesRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  const ids = [...config.deviceIds].sort().join(',')
  useEffect(() => {
    let alive = true
    setRows([])
    setError(null)
    setLoading(true)
    const load = async () => {
      const { from, until } = researchWindow({ from: config.from, until: config.until, source: config.source })
      if (!ids || until <= from) return []
      if (demoMode) {
        const result: SeriesRow[] = []
        for (const id of ids.split(',')) {
          const device = devices.find((d) => d.id === id)
          if (!device) continue
          for (let time = from, i = 0; time < until; time += 3600000, i++) {
            if ((i + Number(id)) % 29 === 11) continue
            const points = config.source === 'minute' ? 60 : 12
            const values = metrics.map(({ key }) =>
              device.latest[key] == null ? null : device.latest[key]! * (1 + Math.sin(i / 3 + Number(id)) * 0.15),
            )
            result.push({
              device_id: id,
              timestamp: new Date(time).toISOString(),
              points,
              pm1: values[0],
              pm25: values[1],
              pm10: values[2],
              temperature: values[3],
              rh: values[4],
              co2: values[5],
              valid_counts: values.map((v) => (v === null ? 0 : points)),
              min_values: values.map((v) => (v === null ? null : v * 0.9)),
              max_values: values.map((v) => (v === null ? null : v * 1.1)),
              sample_rows: points * (config.source === 'minute' ? 30 : 1),
              incomplete_points: config.source === 'minute' && i % 8 === 0 ? 3 : 0,
            })
          }
        }
        return result
      }
      if (!supabase) throw new Error('Database is not configured')
      // PostgREST's default row cap also applies to set-returning RPCs.
      const result: SeriesRow[] = []
      for (let offset = 0; ; offset += 1000) {
        const { data, error: queryError } = await supabase
          .rpc('research_series', {
            p_devices: ids.split(','),
            p_from: new Date(from).toISOString(),
            p_until: new Date(until).toISOString(),
            p_source: config.source,
          })
          .range(offset, offset + 999)
        if (queryError) throw queryError
        if (!alive) return []
        result.push(...(data as SeriesRow[]))
        if (data.length < 1000) return result
      }
    }
    void load()
      .then((data) => {
        if (alive) setRows(data)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : 'Analysis could not be loaded. Please retry.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [ids, config.from, config.until, config.source, version])
  return { rows, loading, error, reload }
}
