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
  onlineMinutes: 20,
  staleMinutes: 40,
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
    if (!saved) return defaultPreferences
    const previous = JSON.parse(saved) as Partial<Preferences>
    // Upgrade browsers still using the old defaults; keep explicitly customized thresholds.
    if (previous.onlineMinutes === 2 && previous.staleMinutes === 10) {
      previous.onlineMinutes = defaultPreferences.onlineMinutes
      previous.staleMinutes = defaultPreferences.staleMinutes
    }
    return { ...defaultPreferences, ...previous }
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
