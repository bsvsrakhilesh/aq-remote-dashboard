/** Stream a numeric logger CSV into small, complete-minute requests. */
export async function uploadCsvChunks(
  file: Blob,
  send: (index: number, body: string, originalBytes: number) => Promise<void>,
  onProgress: (fraction: number) => void,
  targetBytes = 2 * 1024 * 1024,
) {
  const reader = file.stream().getReader()
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true })
  const encoder = new TextEncoder()
  let remainder = ''
  let header = ''
  let body = ''
  let bodyBytes = 0
  let headerBytes = 0
  let lastMinute = ''
  let index = 0
  let confirmed = 0
  const flush = async () => {
    if (!body) return
    const originalBytes = bodyBytes + (index === 0 ? headerBytes : 0)
    await send(index, header + body, originalBytes)
    confirmed += originalBytes
    index++
    body = ''
    bodyBytes = 0
    onProgress(Math.min(1, confirmed / file.size))
  }
  const acceptLine = async (line: string) => {
    if (!header) {
      header = line
      headerBytes = encoder.encode(header).byteLength
      if (headerBytes > 4096) throw new Error('CSV header is too long.')
      return
    }
    const minute = line.slice(0, 16)
    if (bodyBytes >= targetBytes && minute !== lastMinute) await flush()
    body += line
    bodyBytes += encoder.encode(line).byteLength
    lastMinute = minute
    if (bodyBytes + headerBytes > 3 * 1024 * 1024) throw new Error('A CSV chunk is too large.')
  }
  const consume = async (text: string) => {
    remainder += text
    let end: number
    while ((end = remainder.indexOf('\n')) !== -1) {
      await acceptLine(remainder.slice(0, end + 1))
      remainder = remainder.slice(end + 1)
    }
    if (remainder.length > 4096) throw new Error('A CSV row is too long.')
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    await consume(decoder.decode(value, { stream: true }))
  }
  await consume(decoder.decode())
  if (remainder) await acceptLine(remainder)
  if (!header || (!body && index === 0)) throw new Error('The CSV has no data rows.')
  await flush()
  if (Math.abs(confirmed - file.size) > 1) throw new Error('The CSV byte count changed during import.')
  return index
}
