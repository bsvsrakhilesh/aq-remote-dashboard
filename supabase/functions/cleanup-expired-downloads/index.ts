import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface CleanupRow {
  id: string
  storage_path: string | null
}
Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (request.headers.get('x-cleanup-secret') !== Deno.env.get('CLEANUP_SECRET'))
    return new Response('unauthorized', { status: 401 })
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const now = new Date()
  const stale = new Date(now.getTime() - 60 * 60 * 1000).toISOString()
  const [expiredReady, staleActive, failed] = await Promise.all([
    db.from('download_requests').select('id,storage_path').lt('expires_at', now.toISOString()).limit(100),
    db
      .from('download_requests')
      .select('id,storage_path')
      .in('status', ['queued', 'device_acknowledged', 'uploading'])
      .lt('created_at', stale)
      .limit(100),
    db
      .from('download_requests')
      .select('id,storage_path')
      .eq('status', 'failed')
      .not('storage_path', 'is', null)
      .limit(100),
  ])
  const unique = new Map<string, CleanupRow>()
  for (const row of [...(expiredReady.data ?? []), ...(staleActive.data ?? []), ...(failed.data ?? [])] as CleanupRow[])
    unique.set(row.id, row)
  const rows = [...unique.values()]
  const paths = rows.map((row) => row.storage_path).filter((path): path is string => Boolean(path))
  if (paths.length) await db.storage.from('temporary-downloads').remove(paths)
  if (rows.length)
    await db
      .from('download_requests')
      .update({ status: 'expired', storage_path: null })
      .in(
        'id',
        rows.map((row) => row.id),
      )
  return Response.json({ ok: true, expired: rows.length, deleted: paths.length })
})
