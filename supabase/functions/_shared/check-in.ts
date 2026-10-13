import { parseTelemetry, type TelemetryPayload } from './telemetry.ts'

interface HeartbeatPayload {
  timestamp: string
  rssi: number
  sd_ok: boolean
  sps30_ok: boolean
  sht3x_ok: boolean
  rtc_ok: boolean
  scd30_ok: boolean | null
  current_file: string
  current_file_size: number
  firmware_version: string
}

export interface CheckInPayload {
  heartbeat: HeartbeatPayload
  telemetry: TelemetryPayload | null
}

export function parseCheckIn(
  body: unknown,
  receivedAt: string,
): { data: CheckInPayload; error?: never } | { data?: never; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_json' }
  const input = body as Record<string, unknown>
  const hasTrustedTime = typeof input.timestamp === 'string' && !Number.isNaN(Date.parse(input.timestamp))
  if (input.timestamp !== null && !hasTrustedTime) return { error: 'invalid_timestamp' }
  if (!Number.isInteger(input.rssi) || (input.rssi as number) < -120 || (input.rssi as number) > 0)
    return { error: 'invalid_heartbeat' }
  for (const key of ['sd_ok', 'sps30_ok', 'sht3x_ok', 'rtc_ok']) {
    if (typeof input[key] !== 'boolean') return { error: 'invalid_heartbeat' }
  }
  if (input.scd30_ok != null && typeof input.scd30_ok !== 'boolean') return { error: 'invalid_heartbeat' }
  if (
    typeof input.current_file !== 'string' ||
    input.current_file.length > 255 ||
    !Number.isSafeInteger(input.current_file_size) ||
    (input.current_file_size as number) < 0 ||
    typeof input.firmware_version !== 'string' ||
    input.firmware_version.length > 64
  )
    return { error: 'invalid_heartbeat' }

  let telemetry: TelemetryPayload | null = null
  if (hasTrustedTime) {
    if (!input.telemetry || typeof input.telemetry !== 'object' || Array.isArray(input.telemetry))
      return { error: 'invalid_telemetry' }
    const sample = parseTelemetry({ ...input.telemetry, timestamp: input.timestamp })
    if (sample.error !== undefined) return { error: sample.error }
    telemetry = sample.data
  } else if (input.telemetry != null) {
    return { error: 'invalid_telemetry_without_timestamp' }
  }

  return {
    data: {
      heartbeat: {
        timestamp: hasTrustedTime ? (input.timestamp as string) : receivedAt,
        rssi: input.rssi as number,
        sd_ok: input.sd_ok as boolean,
        sps30_ok: input.sps30_ok as boolean,
        sht3x_ok: input.sht3x_ok as boolean,
        rtc_ok: input.rtc_ok as boolean,
        scd30_ok: (input.scd30_ok as boolean | null) ?? null,
        current_file: input.current_file as string,
        current_file_size: input.current_file_size as number,
        firmware_version: input.firmware_version as string,
      },
      telemetry,
    },
  }
}
