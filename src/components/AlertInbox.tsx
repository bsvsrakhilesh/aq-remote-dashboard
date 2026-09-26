import { useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useWorkspaceTable } from '../hooks/useWorkspaceTable'
import { usePreferences } from '../hooks/usePreferences'
import type { AlertEvent } from '../pages/OperationsPage'

export function AlertInbox({ open }: { open: boolean }) {
  const events = useWorkspaceTable<AlertEvent>('alert_events', 'opened_at')
  const { preferences } = usePreferences()
  const started = useRef(Date.now())
  useEffect(() => {
    if (
      !('Notification' in window) ||
      Notification.permission !== 'granted' ||
      localStorage.getItem('aq-desktop-notifications') !== 'true'
    )
      return
    let sent: string[] = []
    try {
      sent = JSON.parse(localStorage.getItem('aq-sent-alerts') ?? '[]')
    } catch {
      /* optional browser state */
    }
    for (const event of events.data) {
      if (
        event.resolved_at ||
        event.acknowledged_at ||
        Date.parse(event.opened_at) < started.current ||
        sent.includes(event.id) ||
        (event.metric === 'offline' && !preferences.offlineAlerts)
      )
        continue
      const notification = new Notification('AQ Observatory · attention needed', { body: event.message, tag: event.id })
      notification.onclick = () => {
        window.focus()
        window.location.hash = '/operations'
        notification.close()
      }
      sent.push(event.id)
    }
    try {
      localStorage.setItem('aq-sent-alerts', JSON.stringify(sent.slice(-200)))
    } catch {
      /* notifications still work without persistence */
    }
  }, [events.data, preferences.offlineAlerts])
  if (!open) return null
  const unread = events.data.filter((e) => !e.acknowledged_at && !e.resolved_at)
  return (
    <div className="notice-popover operational-notices">
      <strong>Attention inbox</strong>
      {events.loading ? (
        <p>Checking alerts…</p>
      ) : events.error ? (
        <p role="alert">Alerts are temporarily unavailable.</p>
      ) : !unread.length ? (
        <p>No unacknowledged open alerts.</p>
      ) : (
        unread.slice(0, 3).map((event) => <p key={event.id}>{event.message}</p>)
      )}
      <Link className="mini-link" to="/operations">
        View rules and event history →
      </Link>
    </div>
  )
}
