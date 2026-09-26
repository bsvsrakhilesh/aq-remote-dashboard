import { useCallback, useEffect, useState } from 'react'
import { demoMode, supabase } from '../services/supabase'

export function useWorkspaceTable<T>(table: string, order: string, enabled = true) {
  const [data, setData] = useState<T[]>([])
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const reload = useCallback(() => setVersion((v) => v + 1), [])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const load = async () => {
      if (demoMode) {
        const rows: unknown = JSON.parse(localStorage.getItem(`aq-demo-${table}`) ?? '[]')
        if (alive) {
          setData(Array.isArray(rows) ? rows : [])
          setLoading(false)
        }
        return
      }
      const result = await supabase!.from(table).select('*').order(order, { ascending: false }).limit(200)
      if (result.error) throw result.error
      if (alive) {
        setData(result.data as T[])
        setError(null)
        setLoading(false)
      }
    }
    const check = () =>
      void load().catch(() => {
        if (alive) {
          setError('Workspace records could not be loaded. Please retry.')
          setLoading(false)
        }
      })
    check()
    const timer = window.setInterval(check, 30000)
    window.addEventListener('aq-workspace-updated', check)
    return () => {
      alive = false
      clearInterval(timer)
      window.removeEventListener('aq-workspace-updated', check)
    }
  }, [table, order, enabled, version])
  return { data, loading, error, reload }
}

export async function workspaceWrite(
  table: string,
  action: 'insert' | 'update' | 'delete',
  values: Record<string, unknown>,
  id?: string,
) {
  if (demoMode) {
    const records = JSON.parse(localStorage.getItem(`aq-demo-${table}`) ?? '[]') as Record<string, unknown>[]
    const next =
      action === 'insert'
        ? [{ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...values }, ...records]
        : action === 'delete'
          ? records.filter((r) => r.id !== id)
          : records.map((r) => (r.id === id ? { ...r, ...values } : r))
    localStorage.setItem(`aq-demo-${table}`, JSON.stringify(next))
  } else {
    const query =
      action === 'insert'
        ? supabase!.from(table).insert(values)
        : action === 'delete'
          ? supabase!.from(table).delete().eq('id', id!)
          : supabase!.from(table).update(values).eq('id', id!)
    const { error } = await query
    if (error)
      throw new Error(
        error.code === '23505' ? 'A matching rule already exists. Edit or remove it first.' : error.message,
      )
  }
  window.dispatchEvent(new Event('aq-workspace-updated'))
}
export async function workspaceRpc(name: string, params: Record<string, unknown> = {}) {
  if (demoMode) return null
  const result = await supabase!.rpc(name, params)
  if (result.error) throw new Error(result.error.message)
  window.dispatchEvent(new Event('aq-workspace-updated'))
  return result.data
}
