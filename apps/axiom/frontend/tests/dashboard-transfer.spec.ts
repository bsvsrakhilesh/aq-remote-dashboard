import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'

const transferId = '467aefbf-90ff-4ac9-9cb1-925a2d9e4244'
const source = {
  job_id: transferId, filename: 'logger.csv', bytes: 112, captured_at: '2026-10-31T00:00:00Z',
  kind: 'raw', device: 'AQ01', sha256: '0'.repeat(64),
}
const catalog = {
  monitors: [{ id: 'sensor', name: 'Logger', filename: 'logger.csv', rows: 2,
    start: '2026-10-31T00:00:00', end: '2026-10-31T01:00:00', invalid_rows: 0, metrics: ['pm25'],
    timestamp_zone: 'UTC' }],
  metrics: [{ id: 'pm25', label: 'PM2.5', unit: 'µg/m³', decimals: 1 }],
  intervals: ['5m'], range: { start: '2026-10-31T00:00:00', end: '2026-10-31T01:00:00' },
  total_rows: 2, invalid_rows: 0, updated_at: '2026-10-31T02:00:00Z',
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/catalog', (route) => route.fulfill({ json: catalog }))
})

test('a dashboard snapshot opens directly into the IST import preview', async ({ page }) => {
  await page.route(`**/api/transfers/${transferId}/inspect`, (route) => route.fulfill({ json: {
    upload_id: `axiom_${transferId}`, filename: 'logger.csv', size: 112, sheets: [], selected_sheet: null,
    columns: [{ name: 'Date', type: 'date/time', sample: ['31-10-2026'], nulls_in_sample: 0 },
      { name: 'Time', type: 'text', sample: ['05:30:00'], nulls_in_sample: 0 }],
    source, sample_rows: 2, suggestions: { date_column: 'Date', time_column: 'Time', measurements: [] },
  } }))
  await page.goto(`/?transfer=${transferId}`, { waitUntil: 'domcontentloaded' })
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText(/Logger time is IST/)).toBeVisible()
  await expect(dialog.getByLabel('Date or timestamp column')).toHaveValue('Date')
  await expect(dialog).toBeFocused()
})

test.use({ timezoneId: 'America/New_York' })

test('logger filters and CSV export remain in IST outside India', async ({ page }) => {
  await page.route('**/api/timeseries?**', (route) => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('end')).toBe('2026-10-31T06:30:00+05:30')
    return route.fulfill({ json: {
      metric: 'PM2.5', unit: 'µg/m³', interval: '5m', start: url.searchParams.get('start'),
      end: url.searchParams.get('end'), total_points: 1, timestamp_zone: 'UTC',
      series: [{ monitor_id: 'sensor', monitor_name: 'Logger', points: [{ timestamp: Date.parse('2026-10-31T00:00:00Z'), value: 12.5 }],
        stats: { latest: 12.5, average: 12.5, minimum: 12.5, maximum: 12.5, p95: 12.5, points: 1 } }],
    } })
  })
  await page.goto('/?view=series', { waitUntil: 'domcontentloaded' })
  await expect(page.getByLabel('To', { exact: true })).toHaveValue('2026-10-31T06:30')
  await expect(page.getByText(/06:30 IST/)).toBeVisible()
  const browserDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export view' }).click()
  const download = await browserDownload
  const path = await download.path()
  expect(path).toBeTruthy()
  const csv = await readFile(path!, 'utf8')
  expect(csv).toContain('timestamp_ist,timestamp_utc')
  expect(csv).toContain('"2026-10-31T05:30:00+05:30","2026-10-31T00:00:00.000Z"')
})
