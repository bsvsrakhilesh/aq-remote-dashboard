import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'

const executablePath = process.env.BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const baseUrl = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173'
const outputDir = '.smoke'
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true })
const failures = []

for (const scenario of [
  { name: 'desktop-fleet', path: '/#/', viewport: { width: 1440, height: 1000 } },
  { name: 'mobile-device', path: '/#/device/AQ01', viewport: { width: 390, height: 844 } },
  { name: 'mobile-files', path: '/#/files', viewport: { width: 390, height: 844 } },
  { name: 'mobile-settings', path: '/#/settings', viewport: { width: 390, height: 844 } },
]) {
  const page = await browser.newPage({ viewport: scenario.viewport, deviceScaleFactor: 1 })
  page.on('pageerror', (error) => failures.push(`${scenario.name}: ${error.message}`))
  await page.goto(`${baseUrl}${scenario.path}`, { waitUntil: 'networkidle' })
  const dimensions = await page.evaluate(() => ({
    body: document.body.scrollWidth,
    root: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))
  if (dimensions.body > dimensions.viewport || dimensions.root > dimensions.viewport) {
    failures.push(`${scenario.name}: horizontal overflow ${JSON.stringify(dimensions)}`)
  }
  try {
    if (scenario.name === 'desktop-fleet') {
      const search = page.getByRole('textbox', { name: 'Search loggers' })
      await search.fill('no-such-logger')
      await page.getByText('No loggers found').waitFor()
      await search.fill('')
    }
    if (scenario.name === 'mobile-device') {
      await page.getByRole('button', { name: 'Refresh list' }).click()
      await page.getByText('Demo catalog refreshed').waitFor()
      await page
        .getByRole('button', { name: /Download AQ01/ })
        .first()
        .click()
      await page.getByRole('dialog').waitFor()
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
    }
    if (scenario.name === 'mobile-files') {
      await page.getByRole('textbox', { name: 'Search files' }).fill('2026-09-22')
      await page.getByRole('button', { name: 'Request' }).first().click()
      await page.getByRole('dialog').waitFor()
      await page.keyboard.press('Escape')
    }
    if (scenario.name === 'mobile-settings') {
      await page.getByRole('button', { name: 'Save preferences' }).click()
      await page.getByText('Preferences saved on this browser.').waitFor()
    }
  } catch (error) {
    failures.push(`${scenario.name}: interaction failure ${error instanceof Error ? error.message : String(error)}`)
  }
  await page.screenshot({ path: `${outputDir}/${scenario.name}.png`, fullPage: true })
  await page.close()
}

await browser.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Visual smoke checks passed: fleet, device, files, downloads, settings, and 390px overflow')
