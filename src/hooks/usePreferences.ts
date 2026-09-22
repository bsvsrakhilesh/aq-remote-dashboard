import { useCallback, useEffect, useState } from 'react'

export interface Preferences {
  onlineMinutes: number
  staleMinutes: number
  refreshSeconds: number
  realtime: boolean
  offlineAlerts: boolean
  sensorAlerts: boolean
  downloadAlerts: boolean
}

export const defaultPreferences: Preferences = {
  onlineMinutes: 2,
  staleMinutes: 10,
  refreshSeconds: 30,
  realtime: true,
  offlineAlerts: true,
  sensorAlerts: true,
  downloadAlerts: true,
}

const STORAGE_KEY = 'aq-observatory-preferences'

function readPreferences(): Preferences {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? { ...defaultPreferences, ...(JSON.parse(saved) as Partial<Preferences>) } : defaultPreferences
  } catch {
    return defaultPreferences
  }
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(readPreferences)
  useEffect(() => {
    const sync = () => setPreferences(readPreferences())
    window.addEventListener('aq-preferences-change', sync)
    return () => window.removeEventListener('aq-preferences-change', sync)
  }, [])
  const save = useCallback((next: Preferences) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setPreferences(next)
    window.dispatchEvent(new Event('aq-preferences-change'))
  }, [])
  return { preferences, save }
}
