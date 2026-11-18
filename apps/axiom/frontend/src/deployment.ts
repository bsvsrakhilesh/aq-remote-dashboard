const configuredBase = (import.meta.env.VITE_API_BASE_URL ?? '').trim().replace(/\/+$/, '')

if (configuredBase) {
  const parsed = new URL(configuredBase)
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('VITE_API_BASE_URL must be an HTTP(S) server URL without credentials, query parameters, or fragments.')
  }
  if (import.meta.env.VITE_STATIC_HOST === 'true' && parsed.protocol !== 'https:') {
    throw new Error('A GitHub Pages deployment requires an HTTPS API URL.')
  }
}

export const needsBackendSetup = import.meta.env.VITE_STATIC_HOST === 'true' && !configuredBase

/** API base excludes /api; all endpoint paths include it explicitly. */
export function apiUrl(path: string): string {
  return `${configuredBase}${path}`
}
