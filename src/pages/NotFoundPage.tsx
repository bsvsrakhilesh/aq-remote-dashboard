import { ArrowLeft, MapPinOff } from 'lucide-react'
import { Link } from 'react-router-dom'

export function NotFoundPage() {
  return (
    <div className="page">
      <div className="empty not-found">
        <MapPinOff size={28} />
        <span className="eyebrow">404 · Route unavailable</span>
        <h1>Nothing is monitored here</h1>
        <p>This page does not exist, or it is unavailable in the current access mode.</p>
        <Link className="button primary" to="/">
          <ArrowLeft size={16} /> Return to fleet overview
        </Link>
      </div>
    </div>
  )
}
