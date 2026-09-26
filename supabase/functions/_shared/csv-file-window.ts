/** Accept only this logger's dated SD files, never an unverified recovery file. */
export function csvFileWindow(filename: string, deviceCode: string, now = Date.now()) {
  if (!filename.startsWith(deviceCode + '_') || filename.includes('/') || filename.includes('\\'))
    throw new Error('Choose a CSV whose filename matches the selected logger.')
  const dates = /^(\d{4}-\d{2}-\d{2})(?:_to_(\d{4}-\d{2}-\d{2}))?\.csv$/i.exec(filename.slice(deviceCode.length + 1))
  if (!dates) throw new Error('Use a dated daily or weekly SD CSV. Recovery files have no verified clock.')
  const parse = (value: string) => {
    const result = Date.parse(value + 'T00:00:00+05:30')
    if (!Number.isFinite(result) || new Date(result + 19800000).toISOString().slice(0, 10) !== value)
      throw new Error('The filename contains an invalid date.')
    return result
  }
  const from = parse(dates[1]),
    end = parse(dates[2] ?? dates[1]) + 86400000
  if (end <= from || end - from > 7 * 86400000 || from > now)
    throw new Error('The CSV date range must be in the past and span at most seven days.')
  return { from, until: Math.min(end, Math.floor(now / 60000) * 60000) }
}
