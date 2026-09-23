import { ArrowDownRight, ArrowUpRight, Clock3, Minus } from 'lucide-react'
import { formatRelative } from '../utils'
export function MetricCard({
  label,
  value,
  unit,
  change,
  tone,
  timestamp,
  decimals = 1,
}: {
  label: string
  value: number | null
  unit: string
  change: number | null
  tone: string
  timestamp: string | undefined
  decimals?: number
}) {
  const Icon = change !== null && change > 0 ? ArrowUpRight : change !== null && change < 0 ? ArrowDownRight : Minus
  return (
    <article className="metric-card" aria-label={label}>
      <div className="metric-top">
        <span>{label}</span>
        <span className={`metric-signal ${tone}`} />
      </div>
      <div className="metric-value">
        {value?.toFixed(decimals) ?? '—'} <small>{unit}</small>
      </div>
      <div className="metric-time">
        <Clock3 size={12} />
        {timestamp ? formatRelative(timestamp) : 'No reading received'}
      </div>
      <div className="metric-foot">
        {change === null ? (
          <>
            <span>
              <Icon size={14} /> —
            </span>
            <span>No prior reading</span>
          </>
        ) : (
          <>
            <span className={change > 0 ? 'up' : 'down'}>
              <Icon size={14} /> {Math.abs(change).toFixed(decimals)}
            </span>
            <span>vs previous reading</span>
          </>
        )}
      </div>
    </article>
  )
}
