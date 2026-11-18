import { test, expect } from '@playwright/test'

const catalog = {
  monitors: [{ id: 'sensor', name: 'Indoor study', filename: 'study.csv', rows: 100, start: '2026-09-01T00:00:00', end: '2026-09-02T00:00:00', invalid_rows: 2, metrics: ['pm25'] }],
  metrics: [{ id: 'pm25', label: 'PM2.5', unit: 'µg/m³', decimals: 1 }, { id: 'co2', label: 'CO₂', unit: 'ppm', decimals: 0 }],
  intervals: ['5m'], range: { start: '2026-09-01T00:00:00', end: '2026-09-02T00:00:00' }, total_rows: 100, invalid_rows: 2, updated_at: '2026-09-02',
}

test.beforeEach(async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ json: catalog }))
  await page.route('**/api/collocation/sessions', route => route.fulfill({ json: [] }))
})

test('overview supports dataset search and responsive navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'See the signal. Understand the data.' })).toBeVisible()
  await page.getByRole('textbox', { name: 'Search datasets' }).fill('not-present')
  await expect(page.getByRole('heading', { name: 'No matching datasets' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear search', exact: true }).first().click()
  await expect(page.getByRole('button', { name: 'Analyze Indoor study' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.getByRole('navigation', { name: 'Workspace', exact: true }).getByRole('button', { name: 'Collocation' }).click()
  await expect(page).toHaveURL(/view=collocation/)
  await expect(page.getByRole('heading', { name: /collocation/i }).first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'See the signal. Understand the data.' })).toBeVisible()
})

test('failed catalog request offers retry instead of an endless loader', async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ status: 503, json: { detail: 'Temporarily unavailable' } }))
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('Couldn’t load your datasets')
  await page.route('**/api/catalog', route => route.fulfill({ json: catalog }))
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByRole('heading', { name: 'Dataset library' })).toBeVisible()
})

test('statistics-only import submits without timestamp or measurement mappings', async ({ page }) => {
  await page.route('**/api/import/inspect', route => route.fulfill({ json: { upload_id: 'fixture', filename: 'categories.csv', size: 30, sheets: [], selected_sheet: null, columns: [{ name: 'Group', type: 'text', sample: ['A', 'B'], nulls_in_sample: 0 }], sample_rows: 2, suggestions: { date_column: null, time_column: null, measurements: [] } } }))
  let payload: Record<string, unknown> | undefined
  await page.route('**/api/import/commit', async route => {
    payload = route.request().postDataJSON()
    await route.fulfill({ json: { dataset: { id: 'import', name: 'categories', rows: 2, invalid_rows: 0, start: null, end: null, columns: [{ name: 'Group' }], metrics: [] } } })
  })
  await page.goto('/')
  const opener = page.getByRole('button', { name: 'Import', exact: true })
  await opener.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeFocused()
  await dialog.locator('input[type=file]').setInputFiles({ name: 'categories.csv', mimeType: 'text/csv', buffer: Buffer.from('Group\nA\nB\n') })
  await expect(dialog.getByLabel('Date or timestamp column')).toHaveValue('')
  await dialog.getByRole('button', { name: 'Import dataset', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'Dataset ready' })).toBeVisible()
  expect(payload?.date_column).toBeNull()
  expect(payload?.measurements).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(opener).toBeFocused()
})

test('draft controls cannot relabel completed chart results', async ({ page }) => {
  await page.route('**/api/timeseries?**', route => route.fulfill({ json: { metric: 'PM2.5', unit: 'µg/m³', interval: '5m', start: catalog.range.start, end: catalog.range.end, total_points: 100, series: [{ monitor_id: 'sensor', monitor_name: 'Indoor study', points: [{ timestamp: 1788220800000, value: 12 }], stats: { latest: 12, average: 10, minimum: 5, maximum: 20, p95: 18, points: 100 } }] } }))
  await page.goto('/?view=series')
  await expect(page.getByText('Data ready', { exact: true })).toBeVisible()
  await page.getByLabel('Metric', { exact: true }).selectOption('co2')
  await expect(page.getByRole('status')).toContainText('Controls have changed')
  await expect(page.locator('.stat-card').first()).toContainText('µg/m³')
  await page.getByLabel('From', { exact: true }).fill('2026-10-01T00:00')
  await expect(page.getByRole('button', { name: 'Update chart' })).toBeDisabled()
  await expect(page.getByRole('alert')).toContainText('end date after the start date')
})

test('distribution diagnostics disclose sampling and handle unevaluable normality', async ({ page }) => {
  await page.route('**/api/statistics/sensor/profile', route => route.fulfill({ json: { dataset: { id: 'sensor', name: 'Indoor study' }, rows: 3, columns: 1, duplicate_rows: 2, missing_cells: 0, invalid_cells: 0, completeness: 100, memory_bytes: 128, type_counts: { numeric: 1, categorical: 0, datetime: 0 }, column_profiles: [{ name: 'Measurement', type: 'numeric', count: 3, missing: 0, invalid: 0, missing_percent: 0, unique: 1, mean: 5, median: 5, std: 0 }] } }))
  await page.route('**/api/statistics/sensor/distribution?**', route => route.fulfill({ json: { column: 'Measurement', count: 3, histogram: { counts: [0, 3, 0], edges: [4, 4.5, 5.5, 6] }, boxplot: { minimum: 5, q1: 5, median: 5, q3: 5, maximum: 5, outliers: 0 }, qq_plot: [[-1, 5], [0, 5], [1, 5]], normality_tests: [], normality_sample_size: 3, sampling_seed: null, likely_normal: null } }))
  await page.goto('/?view=statistics')
  await expect(page.getByRole('heading', { name: 'Column profile' })).toBeVisible()
  await page.getByRole('button', { name: 'Distributions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Normal Q–Q plot' })).toBeVisible()
  await expect(page.getByText('Not evaluable', { exact: true })).toBeVisible()
  await expect(page.getByText(/Normality sample: 3/)).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
})

test('collocation preserves setup across navigation and rejects duplicate sensor names', async ({ page }) => {
  await page.route('**/api/import/inspect', route => route.fulfill({ json: { upload_id: 'fixture', filename: 'sensor.csv', size: 30, sheets: [], selected_sheet: null, columns: [{ name: 'Date', type: 'datetime', sample: ['2026-09-01'], nulls_in_sample: 0 }, { name: 'Value', type: 'number', sample: ['1'], nulls_in_sample: 0 }], sample_rows: 2, suggestions: { date_column: 'Date', time_column: null, measurements: ['Value'] } } }))
  await page.goto('/?view=collocation')
  await page.getByLabel('Study name', { exact: true }).fill('Field campaign')
  const navigation = page.getByRole('navigation', { name: 'Workspace', exact: true })
  await navigation.getByRole('button', { name: 'Overview' }).click()
  await navigation.getByRole('button', { name: 'Collocation' }).click()
  await expect(page.getByLabel('Study name', { exact: true })).toHaveValue('Field campaign')
  await page.locator('.upload-panel input[type=file]').setInputFiles(['first', 'second', 'third'].map(name => ({ name: `${name}.csv`, mimeType: 'text/csv', buffer: Buffer.from('Date,Value\n2026-09-01,1\n') })))
  const run = page.getByRole('button', { name: 'Run collocation analysis' })
  await expect(run).toBeEnabled()
  await page.getByLabel('Sensor name', { exact: true }).nth(1).fill('First')
  await expect(run).toBeDisabled()
  await expect(page.getByRole('status')).toContainText('unique name')
  await page.getByLabel('Sensor name', { exact: true }).nth(1).fill('Second')
  await page.getByLabel('Timestamp column', { exact: true }).nth(2).selectOption('')
  await expect(run).toBeDisabled()
  await expect(page.getByRole('status')).toContainText('every file')
})

test('categorical datasets explain unavailable analyses and can run chi-square', async ({ page }) => {
  await page.route('**/api/statistics/sensor/profile', route => route.fulfill({ json: { dataset: { id: 'sensor', name: 'Categories' }, rows: 20, columns: 2, duplicate_rows: 0, missing_cells: 0, invalid_cells: 0, completeness: 100, memory_bytes: 128, type_counts: { numeric: 0, categorical: 2, datetime: 0 }, column_profiles: ['Group', 'Outcome'].map(name => ({ name, type: 'categorical', count: 20, missing: 0, invalid: 0, missing_percent: 0, unique: 2, top_values: [{ value: 'A', percent: 50 }, { value: 'B', percent: 50 }] })) } }))
  await page.goto('/?view=statistics')
  await page.getByRole('button', { name: 'Distributions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'No numeric columns' })).toBeVisible()
  await page.getByRole('button', { name: 'Relationships', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Select at least two numeric columns' })).toBeVisible()
  await page.getByRole('button', { name: 'Time diagnostics', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Date/time and numeric columns required' })).toBeVisible()
  await page.getByRole('button', { name: 'Statistical tests', exact: true }).click()
  await expect(page.getByLabel('Method', { exact: true })).toHaveValue('chi_square')
  await expect(page.getByRole('button', { name: 'Run analysis', exact: true })).toBeEnabled()
})

test('leaving an in-flight distribution does not lock profile exports', async ({ page }) => {
  await page.route('**/api/statistics/sensor/profile', route => route.fulfill({ json: { dataset: { id: 'sensor', name: 'Study' }, rows: 3, columns: 1, duplicate_rows: 0, missing_cells: 0, invalid_cells: 0, completeness: 100, memory_bytes: 128, type_counts: { numeric: 1, categorical: 0, datetime: 0 }, column_profiles: [{ name: 'Value', type: 'numeric', count: 3, missing: 0, invalid: 0, missing_percent: 0, unique: 3 }] } }))
  await page.route('**/api/statistics/sensor/distribution?**', async route => { await new Promise(resolve => setTimeout(resolve, 1500)); await route.abort() })
  await page.goto('/?view=statistics')
  await expect(page.getByRole('heading', { name: 'Column profile' })).toBeVisible()
  await page.getByRole('button', { name: 'Distributions', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Computing distribution' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Statistical analysis sections' }).getByRole('button', { name: 'Overview', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export analysis', exact: true })).toBeEnabled()
})
