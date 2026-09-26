import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:5177'
await mkdir('.smoke', { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
})
try {
  for (const width of [1440, 390, 320]) {
    for (const theme of ['light', 'dark']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, acceptDownloads: true })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
      await page.goto(`${base}/#/analysis`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Understand your environment.' }).waitFor()
      await page.locator('.research-chart').first().waitFor()
      if (width === 1440 && theme === 'light') {
        await page.getByPlaceholder('e.g. Indoor / outdoor · weekly').fill('Research comparison')
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await page.getByRole('button', { name: 'Research comparison', exact: true }).waitFor()
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: `.smoke/research-analysis-${theme}-${width}.png`, fullPage: true })
      await page.getByRole('button', { name: 'Heatmap' }).click()
      await page.locator('.heatmap-table').first().waitFor()
      await page.getByRole('button', { name: 'Reports' }).click()
      await page.locator('.report-panel').waitFor()
      assert.match(await page.locator('.report-panel').innerText(), /Coverage/i)
      await page.getByRole('button', { name: 'By week' }).click()
      assert.match(await page.locator('.report-panel').innerText(), /Week of/)
      if (width === 1440 && theme === 'light') {
        await page.emulateMedia({ media: 'print' })
        const pdf = await page.pdf({
          path: '.smoke/research-report.pdf',
          format: 'A4',
          landscape: true,
          printBackground: true,
        })
        assert.ok(pdf.byteLength > 2000)
        await page.emulateMedia({ media: 'screen' })
      }
      await page.getByRole('button', { name: 'Data quality' }).click()
      await page.locator('.quality-card').first().waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.goto(`${base}/#/operations`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Operations', exact: true }).waitFor()
      if (width === 1440 && theme === 'light') {
        await page.getByRole('button', { name: 'Add rule' }).click()
        await page.getByText('Alert rule saved. Cloud evaluation is active.').waitFor()
      }
      await page.getByRole('button', { name: 'Deployment notes' }).click()
      await page.getByRole('heading', { name: 'Add a deployment note' }).waitFor()
      if (width === 1440 && theme === 'light') {
        await page
          .getByPlaceholder('Record installation details, maintenance, or context for unusual readings.')
          .fill('Sensor cleaned and checked.')
        await page.getByRole('button', { name: 'Save note' }).click()
        await page.getByText('Sensor cleaned and checked.').waitFor()
      }
      await page.getByRole('button', { name: 'CSV sync' }).click()
      await page.getByRole('heading', { name: 'CSV collection' }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: `.smoke/research-operations-${theme}-${width}.png`, fullPage: true })
      await page.goto(`${base}/#/library`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'Data library' }).waitFor()
      await page.getByRole('button', { name: 'Storage & retention' }).click()
      await page.getByRole('heading', { name: 'Minute-history retention' }).waitFor()
      if (width === 1440 && theme === 'light') {
        await page.getByPlaceholder('Blank = no automatic deletion').fill('30')
        await page.getByRole('button', { name: 'Preview impact' }).click()
        await page.getByText(/120 existing minute points/).waitFor()
        await page.getByRole('checkbox', { name: /I understand the cloud minute points/ }).check()
        await page.getByRole('button', { name: 'Save retention policy' }).click()
        await page.getByText(/Retention saved: 30 days/).waitFor()
      }
      await page.getByRole('button', { name: 'Historical import' }).click()
      await page.getByRole('heading', { name: 'Import an SD CSV' }).waitFor()
      if (width === 1440 && theme === 'light') {
        await page.getByLabel('Choose historical CSV').setInputFiles({
          name: 'AQ01_2026-09-21_to_2026-09-27.csv',
          mimeType: 'text/csv',
          buffer: Buffer.from(
            'Date,Time,MC1.0,MC2.5,MC10.0,Temp,Humidity,CO2\n25-09-2026,00:00:00,10,20,30,25,50,600\n',
          ),
        })
        await page.getByRole('button', { name: 'Preview CSV' }).click()
        await page.getByText('1', { exact: true }).first().waitFor()
        await page.getByRole('button', { name: 'Import averages' }).click()
        await page.getByText('Demo preview complete. No data was uploaded.').waitFor()
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `.smoke/research-library-${theme}-${width}.png`, fullPage: true })
      await page.close()
      console.log(`Research workspace passed: ${theme}, ${width}px`)
    }
  }
} finally {
  await browser.close()
}
