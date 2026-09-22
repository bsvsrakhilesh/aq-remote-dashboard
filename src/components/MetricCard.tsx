import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
export function MetricCard({ label, value, unit, change, tone }: { label: string; value: number | null; unit: string; change: number; tone: string }) {
  const Icon = change > 0 ? ArrowUpRight : change < 0 ? ArrowDownRight : Minus
  return <article className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-signal ${tone}`} /></div><div className="metric-value">{value?.toFixed(1) ?? '—'} <small>{unit}</small></div><div className="metric-foot"><span className={change > 0 ? 'up' : 'down'}><Icon size={14} /> {Math.abs(change).toFixed(1)}</span><span>vs previous reading</span></div></article>
}
