import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173'
await mkdir('.smoke', { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
})
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 768, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 950 } })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
      await page.goto(`${base}/#/device/AQ01`, { waitUntil: 'networkidle' })
      const card = page.getByRole('article', { name: 'CO₂', exact: true })
      await card.waitFor()
      assert.match(await card.innerText(), /ppm/)
      assert.equal(await page.locator('.metrics .metric-card').count(), 5)
      const chartNames = await page
        .locator('.chart-grid .chart-card')
        .evaluateAll((charts) => charts.map((chart) => chart.getAttribute('aria-label')))
      assert.equal(chartNames[0], 'Particles · PM1 history')
      assert.equal(chartNames[1], 'Fine particles · PM2.5 history')
      await page.getByRole('article', { name: 'Particles · PM1 history' }).locator('.recharts-area').waitFor()
      for (const range of ['6h', '24h', '7d', '30d']) {
        await page.getByRole('button', { name: range, exact: true }).click()
        const chart = page.getByRole('article', { name: 'Carbon dioxide · CO₂ history', exact: true })
        await chart.locator('.recharts-area').waitFor()
        assert.match(await chart.innerText(), /ppm/)
      }
      assert.match(await page.locator('.health-list').innerText(), /SCD30/)
      assert.doesNotMatch(await page.locator('.health-list').innerText(), /SHT3x/)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.mouse.move(0, 0)
      await page.screenshot({ path: `.smoke/co2-${theme}-${width}.png`, fullPage: true })
      await page.goto(`${base}/#/device/AQ02`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: /AQ02/ }).waitFor()
      assert.match(await page.locator('.health-list').innerText(), /SHT3x/)
      assert.doesNotMatch(await page.locator('.health-list').innerText(), /SCD30/)
      assert.equal(await page.locator('.metrics .metric-card').count(), 4)
      assert.equal(await page.getByRole('article', { name: 'CO₂', exact: true }).count(), 0)
      assert.equal(await page.getByRole('article', { name: 'Carbon dioxide · CO₂ history', exact: true }).count(), 0)
      await page.goto(`${base}/#/`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Fleet overview' }).waitFor()
      assert.equal(await page.locator('.fleet-co2').count(), 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
      await page.close()
      console.log(`CO2 and non-CO2 devices passed: ${theme}, ${width}px, all ranges`)
    }
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  // Isolated empty-state fixture: no synthetic CO2 or sensor status is inferred.
  await page.route('**/src/hooks/useData.ts', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
    import { devices, telemetryFor } from '/src/mocks/data.ts';
    const device = {...devices[0], health: {...devices[0].health, scd30: null}, latest: {...devices[0].latest, co2: null}};
    const state = data => ({data, loading: false, error: null, reload() {}});
    export const useDevices = () => state([device]);
    export const useTodayTelemetryCount = () => state(0);
    export const useTelemetry = (_, range) => state(telemetryFor(devices[0], range).map(row => ({...row, co2: null})));
    export const useDeviceFiles = () => ({...state([]), requestCatalog: async () => ''});
    export const useAllFiles = () => state([]);
  `,
    }),
  )
  await page.goto(`${base}/#/device/AQ01`, { waitUntil: 'networkidle' })
  assert.match(await page.getByRole('article', { name: 'CO₂', exact: true }).innerText(), /No reading received/)
  assert.match(
    await page.getByRole('article', { name: 'Carbon dioxide · CO₂ history' }).innerText(),
    /No measurements for this period/,
  )
  assert.match(await page.locator('.health-list').innerText(), /Not reported/)
  await page.screenshot({ path: '.smoke/co2-no-readings.png', fullPage: true })
  await page.close()
  console.log('CO2 missing-reading and unknown-sensor states passed')
} finally {
  await browser.close()
}
