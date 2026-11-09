interface ActiveDownload {
  status: string
  expires_at: string | null
}

export function shouldReuseDownload(active: ActiveDownload | null, refreshReady: boolean, now = Date.now()) {
  if (!active) return false
  if (active.status !== 'ready') return true
  if (refreshReady) return false
  return !!active.expires_at && Date.parse(active.expires_at) > now
}
