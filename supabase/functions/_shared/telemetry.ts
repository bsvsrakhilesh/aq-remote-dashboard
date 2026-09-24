export interface TelemetryPayload {
  timestamp: string
  pm1: number | null
  pm25: number | null
  pm10: number | null
  temperature: number | null
  rh: number | null
  co2: number | null
}

export function parseTelemetry(
  body: unknown,
): { data: TelemetryPayload; error?: never } | { data?: never; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'invalid_json' }
  const sample = body as Record<string, unknown>
  if (typeof sample.timestamp !== 'string' || !sample.timestamp || Number.isNaN(Date.parse(sample.timestamp)))
    return { error: 'invalid_timestamp' }
  for (const key of ['pm25', 'pm10', 'temperature', 'rh'] as const) {
    const value = sample[key]
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return { error: `invalid_${key}` }
  }
  // PM1 is optional so existing loggers can continue sending their current payloads.
  const pm1 = sample.pm1 ?? null
  if (pm1 !== null && (typeof pm1 !== 'number' || !Number.isFinite(pm1) || pm1 < 0 || pm1 > 10000))
    return { error: 'invalid_pm1' }
  // Omitted CO2 remains compatible with firmware that only sends the original four measurements.
  const co2 = sample.co2 ?? null
  if (co2 !== null && (typeof co2 !== 'number' || !Number.isFinite(co2) || co2 <= 0 || co2 > 1000000))
    return { error: 'invalid_co2' }
  return {
    data: {
      timestamp: sample.timestamp,
      pm1,
      pm25: sample.pm25 as number | null,
      pm10: sample.pm10 as number | null,
      temperature: sample.temperature as number | null,
      rh: sample.rh as number | null,
      co2,
    },
  }
}
