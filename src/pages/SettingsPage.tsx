import { Bell, CheckCircle2, Clock, Cloud, Info, Save, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usePreferences, type Preferences } from '../hooks/usePreferences'
import { demoMode } from '../services/supabase'

export function SettingsPage() {
  const { preferences, save } = usePreferences()
  const [draft, setDraft] = useState<Preferences>(preferences)
  const [saved, setSaved] = useState(false)
  useEffect(() => setDraft(preferences), [preferences])
  const update = <K extends keyof Preferences>(key: K, value: Preferences[K]) =>
    setDraft((current) => ({ ...current, [key]: value }))
  const submit = () => {
    const onlineMinutes = Math.max(1, Math.min(draft.onlineMinutes, 30))
    const staleMinutes = Math.max(onlineMinutes + 1, Math.min(draft.staleMinutes, 120))
    save({ ...draft, onlineMinutes, staleMinutes })
    setSaved(true)
    window.setTimeout(() => setSaved(false), 2200)
  }
  return (
    <div className="page settings-page">
      <section className="page-heading">
        <div>
          <span className="eyebrow">Workspace preferences</span>
          <h1>Settings</h1>
          <p>Configure display, connectivity thresholds and notifications.</p>
        </div>
      </section>
      {saved && (
        <div className="success-banner" role="status">
          <CheckCircle2 size={16} /> Preferences saved on this browser.
        </div>
      )}
      <div className="settings-grid">
        <section className="panel settings-card">
          <div className="settings-title">
            <Clock />
            <div>
              <h2>Status thresholds</h2>
              <p>Heartbeat age used across the dashboard.</p>
            </div>
          </div>
          <label>
            Online until{' '}
            <span>
              <input
                value={draft.onlineMinutes}
                onChange={(event) => update('onlineMinutes', Number(event.target.value))}
                min="1"
                max="30"
                type="number"
              />{' '}
              minutes
            </span>
          </label>
          <label>
            Stale until{' '}
            <span>
              <input
                value={draft.staleMinutes}
                onChange={(event) => update('staleMinutes', Number(event.target.value))}
                min={draft.onlineMinutes + 1}
                max="120"
                type="number"
              />{' '}
              minutes
            </span>
          </label>
        </section>
        <section className="panel settings-card">
          <div className="settings-title">
            <Cloud />
            <div>
              <h2>Data refresh</h2>
              <p>Balance freshness with network usage.</p>
            </div>
          </div>
          <label>
            Refresh interval{' '}
            <select
              value={draft.refreshSeconds}
              onChange={(event) => update('refreshSeconds', Number(event.target.value))}
            >
              <option value="15">15 seconds</option>
              <option value="30">30 seconds</option>
              <option value="60">1 minute</option>
            </select>
          </label>
          <label className="toggle-row">
            Realtime transfer updates{' '}
            <input
              type="checkbox"
              checked={draft.realtime}
              onChange={(event) => update('realtime', event.target.checked)}
            />
          </label>
        </section>
        <section className="panel settings-card">
          <div className="settings-title">
            <Bell />
            <div>
              <h2>Notifications</h2>
              <p>Choose which operational events receive attention.</p>
            </div>
          </div>
          <label className="toggle-row">
            Logger offline{' '}
            <input
              type="checkbox"
              checked={draft.offlineAlerts}
              onChange={(event) => update('offlineAlerts', event.target.checked)}
            />
          </label>
          <label className="toggle-row">
            Sensor fault{' '}
            <input
              type="checkbox"
              checked={draft.sensorAlerts}
              onChange={(event) => update('sensorAlerts', event.target.checked)}
            />
          </label>
          <label className="toggle-row">
            Download completed{' '}
            <input
              type="checkbox"
              checked={draft.downloadAlerts}
              onChange={(event) => update('downloadAlerts', event.target.checked)}
            />
          </label>
        </section>
        <section className="panel settings-card security">
          <div className="settings-title">
            <ShieldCheck />
            <div>
              <h2>Security posture</h2>
              <p>Browser access is protected by row-level policies.</p>
            </div>
          </div>
          <div className="security-line">
            <span>Data source</span>
            <strong>{demoMode ? 'Isolated demo' : 'Supabase production'}</strong>
          </div>
          <div className="security-line">
            <span>Temporary file retention</span>
            <strong>15 minutes</strong>
          </div>
          <div className="security-line">
            <span>Public storage</span>
            <strong>Disabled</strong>
          </div>
        </section>
      </div>
      <section className="panel about-panel">
        <Info />
        <div>
          <span className="eyebrow">About this workspace</span>
          <h2>AQ Observatory 1.0</h2>
          <p>
            Remote five-minute telemetry and temporary SD-file transfer for XIAO ESP32-S3 environmental loggers. The
            local logger dashboard and full-resolution SD recording remain independent of this cloud interface.
          </p>
        </div>
        <a href="https://github.com/bsvsrakhilesh/aq-remote-dashboard" target="_blank" rel="noreferrer">
          View source ↗
        </a>
      </section>
      <button className="button primary save" onClick={submit}>
        <Save size={17} /> Save preferences
      </button>
    </div>
  )
}
