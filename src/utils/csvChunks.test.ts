import { describe, expect, it } from 'vitest'
import { CsvMinuteAggregator } from '../../supabase/functions/_shared/csv-minute-history'
import { uploadCsvChunks } from './csvChunks'

describe('streaming historical CSV import', () => {
  it('preserves complete minute groups and exact byte accounting across requests', async () => {
    const header = 'Date,Time,MC1.0,MC2.5,MC10.0,Temp_C,Humidity_RH_percent\n'
    const source =
      header +
      Array.from(
        { length: 12 },
        (_, i) =>
          `25-09-2026,00:${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 2).padStart(2, '0')},10,20,30,25,50\n`,
      ).join('')
    const requests: { index: number; body: string; bytes: number }[] = []
    const progress: number[] = []
    const file = new Blob([source])
    const count = await uploadCsvChunks(
      file,
      async (index, body, bytes) => {
        requests.push({ index, body, bytes })
      },
      (fraction) => progress.push(fraction),
      120,
    )
    expect(count).toBeGreaterThan(1)
    expect(requests.reduce((sum, request) => sum + request.bytes, 0)).toBe(file.size)
    expect(progress.at(-1)).toBe(1)
    expect(requests.map((request) => request.index)).toEqual(requests.map((_, index) => index))
    const pointCounts = requests.flatMap((request) => {
      const parser = new CsvMinuteAggregator(
        Date.parse('2026-09-25T00:00:00+05:30'),
        Date.parse('2026-09-25T00:03:00+05:30'),
        false,
      )
      parser.push(request.body)
      return parser.finish().map((point) => point.sample_count)
    })
    expect(pointCounts).toEqual([4, 4, 4])
  })
  it('rejects a file with no data rows', async () => {
    await expect(
      uploadCsvChunks(
        new Blob(['Date,Time\n']),
        async () => {},
        () => {},
      ),
    ).rejects.toThrow('no data rows')
  })
  it('preserves a UTF-8 BOM in byte accounting', async () => {
    const file = new Blob([
      '\uFEFFDate,Time,MC1.0,MC2.5,MC10.0,Temp_C,Humidity_RH_percent\n25-09-2026,00:00:00,10,20,30,25,50\n',
    ])
    let sent = 0
    await uploadCsvChunks(
      file,
      async (_, body, originalBytes) => {
        sent += originalBytes
        expect(body.startsWith('\uFEFF')).toBe(true)
      },
      () => {},
    )
    expect(sent).toBe(file.size)
  })
})
