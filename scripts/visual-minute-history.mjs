import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'

const base = process.env.SMOKE_URL ?? 'http://127.0.0.1:5175'
await mkdir('.smoke', { recursive: true })
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
})
try {
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 390, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 950 } })
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.addInitScript((value) => localStorage.setItem('theme', value), theme)
      await page.goto(`${base}/#/device/AQ01/history`, { waitUntil: 'networkidle' })
      await page.getByRole('heading', { name: 'One-minute history', exact: true }).waitFor()
      const yesterday = new Date(Date.now() + 19800000 - 86400000).toISOString().slice(0, 10)
      await page.getByLabel('History date').fill(yesterday)
      await page.locator('.chart-grid .chart-card').first().waitFor()
      assert.equal(await page.locator('.chart-grid .chart-card').count(), 6)
      assert.match(await page.locator('.chart-grid .chart-card').first().innerText(), /PM1/)
      assert.match(await page.locator('.history-sync-badge').innerText(), /00:00 & 12:00 IST/)
      await page.getByRole('button', { name: 'Pause automatic sync' }).click()
      await page.getByRole('button', { name: 'Resume automatic sync' }).waitFor()
      await page.getByRole('button', { name: 'Resume automatic sync' }).click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.evaluate(() => {
        document.activeElement?.blur()
        window.scrollTo(0, 0)
      })
      await page.screenshot({ path: `.smoke/history-${theme}-${width}.png`, fullPage: true })
      await page.getByLabel('History logger').selectOption('AQ02')
      await page.waitForURL('**/#/device/AQ02/history')
      await page.waitForFunction(() => document.querySelectorAll('.chart-grid .chart-card').length === 5)
      assert.equal(await page.locator('.chart-grid .chart-card').count(), 5)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      assert.deepEqual(errors, [])
      await page.close()
      console.log(`Minute history passed: ${theme}, ${width}px, both logger types`)
    }
  }
} finally {
  await browser.close()
}
