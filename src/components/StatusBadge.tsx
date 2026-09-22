import { AlertTriangle, CheckCircle2, CircleOff } from 'lucide-react'
import type { DeviceState } from '../types'
export function StatusBadge({ state }: { state: DeviceState }) {
  const Icon = state === 'online' ? CheckCircle2 : state === 'stale' ? AlertTriangle : CircleOff
  return <span className={`status-badge ${state}`}><Icon size={13} />{state}</span>
}
