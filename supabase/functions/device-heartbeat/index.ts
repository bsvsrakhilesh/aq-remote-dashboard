import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

interface HeartbeatBody {
  timestamp?: string
  rssi?: number
  sd_ok?: boolean
  sps30_ok?: boolean
  sht3x_ok?: boolean
  rtc_ok?: boolean
  current_file?: string
  current_file_size?: number
  firmware_version?: string
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, { ok: false, error: 'method_not_allowed' }, 405)
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)
  const body = (await request.json().catch(() => null)) as HeartbeatBody | null
  const validTimestamp = body?.timestamp && !Number.isNaN(Date.parse(body.timestamp))
  const validRssi = Number.isInteger(body?.rssi) && body!.rssi! >= -120 && body!.rssi! <= 0
  const validHealth = ['sd_ok', 'sps30_ok', 'sht3x_ok', 'rtc_ok'].every(
    (key) => typeof body?.[key as keyof HeartbeatBody] === 'boolean',
  )
  const validFile =
    typeof body?.current_file === 'string' &&
    body.current_file.length <= 255 &&
    Number.isSafeInteger(body.current_file_size) &&
    body.current_file_size! >= 0
  const validFirmware = typeof body?.firmware_version === 'string' && body.firmware_version.length <= 64
  if (!validTimestamp || !validRssi || !validHealth || !validFile || !validFirmware)
    return json(request, { ok: false, error: 'invalid_heartbeat' }, 400)
  const { error } = await auth.db
    .from('devices')
    .update({
      last_seen: body.timestamp,
      wifi_rssi: body.rssi,
      sd_ok: body.sd_ok,
      sps30_ok: body.sps30_ok,
      sht3x_ok: body.sht3x_ok,
      rtc_ok: body.rtc_ok,
      current_filename: body.current_file,
      current_file_size: body.current_file_size,
      firmware_version: body.firmware_version,
    })
    .eq('id', auth.device.id)
  return error ? json(request, { ok: false, error: 'write_failed' }, 500) : json(request, { ok: true })
})
