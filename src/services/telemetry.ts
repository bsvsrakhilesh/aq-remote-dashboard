// Supabase limits individual responses; a month of five-minute samples needs multiple pages.
export async function collectTelemetryPages<T>(fetchPage: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const result: T[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const page = await fetchPage(offset, offset + pageSize - 1)
    result.push(...page)
    if (page.length < pageSize) return result
  }
}
