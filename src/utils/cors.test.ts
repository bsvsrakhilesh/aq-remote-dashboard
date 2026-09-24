import { afterEach, describe, expect, it, vi } from 'vitest'
import { corsHeaders } from '../../supabase/functions/_shared/http'

afterEach(() => vi.unstubAllGlobals())

describe('Edge Function browser CORS', () => {
  it('allows the headers sent by Supabase browser function calls', () => {
    vi.stubGlobal('Deno', { env: { get: () => 'https://dashboard.example' } })
    const headers = corsHeaders(
      new Request('https://project.supabase.co/functions/v1/request-file-download', {
        headers: { origin: 'https://dashboard.example' },
      }),
    )
    expect(headers['Access-Control-Allow-Origin']).toBe('https://dashboard.example')
    const allowed = headers['Access-Control-Allow-Headers'].split(',').map((header) => header.trim())
    expect(allowed).toEqual(expect.arrayContaining(['authorization', 'apikey', 'content-type', 'x-client-info']))
  })
})
