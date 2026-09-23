import { useCallback, useEffect, useMemo, useState } from 'react'
import { devices as mockDevices, filesFor, telemetryFor } from '../mocks/data'
import { demoMode, readOnlyMode, supabase } from '../services/supabase'
import { collectTelemetryPages } from '../services/telemetry'
import type { Device, DeviceFile, RangeKey, Reading } from '../types'
import { rangeHours } from '../utils'
import { usePreferences } from './usePreferences'

export interface AsyncState<T> {
  data: T
  loading: boolean
  error: string | null
  reload: () => void
}
export interface FleetFile {
  file: DeviceFile
  device: Pick<Device, 'id' | 'code' | 'name' | 'lastSeen'>
}
export interface DeviceFilesState extends AsyncState<DeviceFile[]> {
  requestCatalog: () => Promise<string>
}

interface DeviceRow {
  id: string
  device_code: string
  display_name: string | null
  description: string | null
  firmware_version: string | null
  last_seen: string | null
  wifi_rssi: number | null
  sd_ok: boolean | null
  sps30_ok: boolean | null
  sht3x_ok: boolean | null
  rtc_ok: boolean | null
  current_filename: string | null
  current_file_size: number | null
  co2_enabled: boolean
  scd30_ok: boolean | null
}
interface TelemetryRow {
  device_id: string
  timestamp: string
  pm25: number | null
  pm10: number | null
  temperature_c: number | null
  rh: number | null
  co2_ppm: number | null
}

const fallbackReading = (timestamp: string): Reading => ({
  timestamp,
  pm25: null,
  pm10: null,
  temperature: null,
  rh: null,
  co2: null,
})
const mapDevice = (row: DeviceRow, latest?: TelemetryRow): Device => ({
  id: row.id,
  code: row.device_code,
  name: row.display_name ?? row.device_code,
  location: row.description ?? 'Location not specified',
  firmware: row.firmware_version ?? 'Unknown',
  lastSeen: row.last_seen ?? new Date(0).toISOString(),
  rssi: row.wifi_rssi ?? -100,
  co2Enabled: row.co2_enabled,
  health: {
    sd: row.sd_ok ?? false,
    sps30: row.sps30_ok ?? false,
    sht3x: row.sht3x_ok ?? false,
    rtc: row.rtc_ok ?? false,
    scd30: row.scd30_ok,
  },
  latest: latest
    ? {
        timestamp: latest.timestamp,
        pm25: latest.pm25,
        pm10: latest.pm10,
        temperature: latest.temperature_c,
        rh: latest.rh,
        co2: latest.co2_ppm ?? null,
      }
    : fallbackReading(row.last_seen ?? new Date(0).toISOString()),
  currentFilename: row.current_filename ?? 'No active file',
  currentFileSize: row.current_file_size ?? 0,
})

function useReloadVersion(autoRefresh = true) {
  const [version, setVersion] = useState(0)
  const { preferences } = usePreferences()
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  useEffect(() => {
    if (!autoRefresh || !preferences.realtime) return
    const timer = window.setInterval(reload, preferences.refreshSeconds * 1000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, preferences.realtime, preferences.refreshSeconds, reload])
  return { version, reload }
}

export function useDevices(): AsyncState<Device[]> {
  const [data, setData] = useState<Device[]>(demoMode ? mockDevices : [])
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | null>(null)
  const { version, reload } = useReloadVersion()
  useEffect(() => {
    if (demoMode) {
      const offsets = [0.3, 1.2, 47, 6]
      setData(
        mockDevices.map((device, index) => ({
          ...device,
          lastSeen: new Date(Date.now() - (offsets[index] ?? 1) * 60000).toISOString(),
        })),
      )
      setLoading(false)
      return
    }
    if (!supabase) return
    const client = supabase
    let alive = true
    void (async () => {
      setLoading(true)
      setError(null)
      const { data: rows, error: deviceError } = await client
        .from('devices')
        .select(
          'id,device_code,display_name,description,firmware_version,last_seen,wifi_rssi,sd_ok,sps30_ok,sht3x_ok,rtc_ok,current_filename,current_file_size,co2_enabled,scd30_ok',
        )
        .order('device_code')
      if (deviceError) {
        if (alive) {
          setError('The device registry is temporarily unavailable.')
          setLoading(false)
        }
        return
      }
      const typed = (rows ?? []) as DeviceRow[]
      const latest = await Promise.all(
        typed.map(async (device) => {
          const { data: reading } = await client
            .from('telemetry_5min')
            .select('device_id,timestamp,pm25,pm10,temperature_c,rh,co2_ppm')
            .eq('device_id', device.id)
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle()
          return reading as TelemetryRow | null
        }),
      )
      if (alive) {
        setData(typed.map((device, index) => mapDevice(device, latest[index] ?? undefined)))
        setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [version])
  return { data, loading, error, reload }
}

export function useTodayTelemetryCount(): AsyncState<number> {
  const [data, setData] = useState(demoMode ? 1096 : 0)
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | null>(null)
  const { version, reload } = useReloadVersion()
  useEffect(() => {
    if (!supabase) return
    let alive = true
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    void supabase
      .from('telemetry_5min')
      .select('id', { count: 'exact', head: true })
      .gte('timestamp', start.toISOString())
      .then(({ count, error: countError }) => {
        if (!alive) return
        if (countError) setError("Today's telemetry count is unavailable.")
        else setData(count ?? 0)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [version])
  return { data, loading, error, reload }
}

export function useTelemetry(device: Device | null, range: RangeKey): AsyncState<Reading[]> {
  const initial = demoMode && device ? telemetryFor(device, range) : []
  const [data, setData] = useState<Reading[]>(initial)
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | null>(null)
  const { version, reload } = useReloadVersion()
  useEffect(() => {
    if (demoMode && device) {
      setData(telemetryFor(device, range))
      setLoading(false)
      return
    }
    if (!supabase || !device) return
    let alive = true
    setLoading(true)
    setError(null)
    const since = new Date(Date.now() - rangeHours[range] * 3600000).toISOString()
    const until = new Date().toISOString()
    const client = supabase
    void collectTelemetryPages<TelemetryRow>(async (from, to) => {
      if (!alive) return []
      const { data: rows, error: telemetryError } = await client
        .from('telemetry_5min')
        .select('device_id,timestamp,pm25,pm10,temperature_c,rh,co2_ppm')
        .eq('device_id', device.id)
        .gte('timestamp', since)
        .lte('timestamp', until)
        .order('timestamp')
        .range(from, to)
      if (telemetryError) throw telemetryError
      return (rows ?? []) as TelemetryRow[]
    })
      .then((rows) => {
        if (!alive) return
        setData(
          rows.map((reading) => ({
            timestamp: reading.timestamp,
            pm25: reading.pm25,
            pm10: reading.pm10,
            temperature: reading.temperature_c,
            rh: reading.rh,
            co2: reading.co2_ppm ?? null,
          })),
        )
        setLoading(false)
      })
      .catch(() => {
        if (!alive) return
        setError('Measurements could not be loaded. Check your connection and retry.')
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [device, range, version])
  return { data, loading, error, reload }
}

export function useDeviceFiles(device: Device | null): DeviceFilesState {
  const initial = demoMode && device ? filesFor(device.code) : []
  const [data, setData] = useState<DeviceFile[]>(initial)
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | null>(null)
  const { version, reload } = useReloadVersion(false)
  useEffect(() => {
    if (readOnlyMode && !demoMode) {
      setData([])
      setLoading(false)
      setError(null)
      return
    }
    if (demoMode && device) {
      setData(filesFor(device.code))
      setLoading(false)
      return
    }
    if (!supabase || !device) return
    let alive = true
    setLoading(true)
    setError(null)
    void supabase
      .from('device_files')
      .select('id,filename,size_bytes,modified_at')
      .eq('device_id', device.id)
      .order('modified_at', { ascending: false })
      .then(({ data: rows, error: fileError }) => {
        if (!alive) return
        if (fileError) setError('The logger file catalog is temporarily unavailable.')
        else
          setData(
            (rows ?? []).map((row) => ({
              id: String(row.id),
              filename: String(row.filename),
              size: Number(row.size_bytes),
              modifiedAt: row.modified_at ? String(row.modified_at) : new Date(0).toISOString(),
            })),
          )
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [device, version])
  const requestCatalog = useCallback(async () => {
    if (!device) throw new Error('Device is not available')
    if (readOnlyMode) throw new Error('File commands are disabled in read-only mode')
    if (demoMode) {
      await new Promise((resolve) => window.setTimeout(resolve, 700))
      reload()
      return 'Demo catalog refreshed'
    }
    if (!supabase) throw new Error('Supabase is not configured')
    const { error: invokeError } = await supabase.functions.invoke('request-file-list', {
      body: { device_id: device.id },
    })
    if (invokeError) throw new Error('Could not contact the command service. Please retry.')
    ;[3000, 8000, 15000, 25000].forEach((delay) => window.setTimeout(reload, delay))
    return 'File-list command queued'
  }, [device, reload])
  return { data, loading, error, reload, requestCatalog }
}

export function useAllFiles(): AsyncState<FleetFile[]> {
  const demo = useMemo(
    () =>
      mockDevices.flatMap((device) =>
        filesFor(device.code).map((file) => ({
          file,
          device: { id: device.id, code: device.code, name: device.name, lastSeen: device.lastSeen },
        })),
      ),
    [],
  )
  const [data, setData] = useState<FleetFile[]>(demoMode ? demo : [])
  const [loading, setLoading] = useState(!demoMode)
  const [error, setError] = useState<string | null>(null)
  const { version, reload } = useReloadVersion()
  useEffect(() => {
    if (!supabase) return
    let alive = true
    setLoading(true)
    setError(null)
    void supabase
      .from('device_files')
      .select('id,filename,size_bytes,modified_at,devices!inner(id,device_code,display_name,last_seen)')
      .order('modified_at', { ascending: false })
      .then(({ data: rows, error: fileError }) => {
        if (!alive) return
        if (fileError) setError('The fleet file catalog is temporarily unavailable.')
        else
          setData(
            (rows ?? []).map((row) => {
              const joined = row.devices as unknown as {
                id: string
                device_code: string
                display_name: string | null
                last_seen: string | null
              }
              return {
                file: {
                  id: String(row.id),
                  filename: String(row.filename),
                  size: Number(row.size_bytes),
                  modifiedAt: row.modified_at ? String(row.modified_at) : new Date(0).toISOString(),
                },
                device: {
                  id: joined.id,
                  code: joined.device_code,
                  name: joined.display_name ?? joined.device_code,
                  lastSeen: joined.last_seen ?? new Date(0).toISOString(),
                },
              }
            }),
          )
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [version])
  return { data, loading, error, reload }
}
