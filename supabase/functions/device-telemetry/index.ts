import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  const auth = await authenticateDevice(req)
  if (!auth) return json(req, { ok: false, error: 'unauthorized' }, 401)
  try {
    const b = await req.json()
    if (!b.timestamp || Number.isNaN(Date.parse(b.timestamp)))
      return json(req, { ok: false, error: 'invalid_timestamp' }, 400)
    for (const k of ['pm25', 'pm10', 'temperature', 'rh'])
      if (b[k] !== null && typeof b[k] !== 'number') return json(req, { ok: false, error: `invalid_${k}` }, 400)
    const { error } = await auth.db.from('telemetry_5min').upsert(
      {
        device_id: auth.device.id,
        timestamp: b.timestamp,
        pm25: b.pm25,
        pm10: b.pm10,
        temperature_c: b.temperature,
        rh: b.rh,
      },
      { onConflict: 'device_id,timestamp' },
    )
    return error ? json(req, { ok: false, error: 'write_failed' }, 500) : json(req, { ok: true })
  } catch {
    return json(req, { ok: false, error: 'invalid_json' }, 400)
  }
})
