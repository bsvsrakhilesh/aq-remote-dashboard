import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'
import { parseTelemetry } from '../_shared/telemetry.ts'
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
  if (req.method !== 'POST') return json(req, { ok: false, error: 'method_not_allowed' }, 405)
  const auth = await authenticateDevice(req)
  if (!auth) return json(req, { ok: false, error: 'unauthorized' }, 401)
  try {
    const parsed = parseTelemetry(await req.json())
    if (parsed.error !== undefined) return json(req, { ok: false, error: parsed.error }, 400)
    const b = parsed.data
    const { error } = await auth.db.from('telemetry_5min').upsert(
      {
        device_id: auth.device.id,
        timestamp: b.timestamp,
        pm1: b.pm1,
        pm25: b.pm25,
        pm10: b.pm10,
        temperature_c: b.temperature,
        rh: b.rh,
        co2_ppm: b.co2,
      },
      { onConflict: 'device_id,timestamp' },
    )
    return error ? json(req, { ok: false, error: 'write_failed' }, 500) : json(req, { ok: true })
  } catch {
    return json(req, { ok: false, error: 'invalid_json' }, 400)
  }
})
