// Supabase limits individual responses; a month of fifteen-minute samples needs multiple pages.
export async function collectTelemetryPages<T>(fetchPage: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const result: T[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(offset, offset + pageSize - 1)
    result.push(...page)
    if (page.length < pageSize) return result
  }
}

// Replace overlapping samples with the latest server values and trim rows that
// have moved outside the selected chart window.
export function mergeTelemetryRows<T extends { timestamp: string }>(
  cached: T[],
  fresh: T[],
  windowStartMs: number,
): T[] {
  const byTime = new Map<number, T>()
  for (const row of [...cached, ...fresh]) {
    const time = Date.parse(row.timestamp)
    if (time >= windowStartMs) byTime.set(time, row)
  }
  return [...byTime.entries()].sort(([a], [b]) => a - b).map(([, row]) => row)
}
