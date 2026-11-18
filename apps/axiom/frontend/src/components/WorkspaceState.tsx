import { Database, LoaderCircle } from 'lucide-react'
import type { ReactNode } from 'react'

export function WorkspaceState({ title, children, loading = false, action }: { title: string; children?: ReactNode; loading?: boolean; action?: ReactNode }) {
  return <div className={`workspace-state ${loading ? 'is-loading' : ''}`} role={loading ? 'status' : undefined}>
    <span className="state-icon">{loading ? <LoaderCircle size={22} className="spin" /> : <Database size={22} />}</span>
    <h2>{title}</h2>{children && <p>{children}</p>}{action}
  </div>
}
