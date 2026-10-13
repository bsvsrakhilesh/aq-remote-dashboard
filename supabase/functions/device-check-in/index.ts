import { parseCheckIn } from '../_shared/check-in.ts'
import { authenticateDevice } from '../_shared/device-auth.ts'
import { corsHeaders, json } from '../_shared/http.ts'

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(request) })
  if (request.method !== 'POST') return json(request, { ok: false, error: 'method_not_allowed' }, 405)
  const auth = await authenticateDevice(request)
  if (!auth) return json(request, { ok: false, error: 'unauthorized' }, 401)

  const parsed = parseCheckIn(await request.json().catch(() => null), new Date().toISOString())
  if (parsed.error !== undefined) return json(request, { ok: false, error: parsed.error }, 400)
  const { heartbeat, telemetry } = parsed.data

  if (telemetry) {
    const { error } = await auth.db.from('telemetry_5min').upsert(
      {
        device_id: auth.device.id,
        timestamp: telemetry.timestamp,
        pm1: telemetry.pm1,
        pm25: telemetry.pm25,
        pm10: telemetry.pm10,
        temperature_c: telemetry.temperature,
        rh: telemetry.rh,
        co2_ppm: telemetry.co2,
      },
      { onConflict: 'device_id,timestamp' },
    )
    if (error) return json(request, { ok: false, error: 'telemetry_write_failed' }, 500)
  }

  const { error: heartbeatError } = await auth.db
    .from('devices')
    .update({
      last_seen: heartbeat.timestamp,
      wifi_rssi: heartbeat.rssi,
      sd_ok: heartbeat.sd_ok,
      sps30_ok: heartbeat.sps30_ok,
      sht3x_ok: heartbeat.sht3x_ok,
      rtc_ok: heartbeat.rtc_ok,
      scd30_ok: heartbeat.scd30_ok,
      current_filename: heartbeat.current_file,
      current_file_size: heartbeat.current_file_size,
      firmware_version: heartbeat.firmware_version,
    })
    .eq('id', auth.device.id)
  if (heartbeatError) return json(request, { ok: false, error: 'heartbeat_write_failed' }, 500)

  const expiry = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { error: expiryError } = await auth.db
    .from('device_commands')
    .update({ status: 'expired', error_message: 'Command was not acknowledged within 60 minutes' })
    .eq('device_id', auth.device.id)
    .eq('status', 'queued')
    .lt('created_at', expiry)
  if (expiryError) return json(request, { ok: false, error: 'command_expiry_failed' }, 500)

  const { data: command, error: commandError } = await auth.db
    .from('device_commands')
    .select('id,command_type,payload')
    .eq('device_id', auth.device.id)
    .eq('status', 'queued')
    .order('created_at')
    .limit(1)
    .maybeSingle()
  if (commandError) return json(request, { ok: false, error: 'command_read_failed' }, 500)
  const payload =
    command?.payload && typeof command.payload === 'object' && !Array.isArray(command.payload) ? command.payload : {}
  return json(
    request,
    command ? { ...payload, command_id: command.id, command: command.command_type } : { command: null },
  )
})
