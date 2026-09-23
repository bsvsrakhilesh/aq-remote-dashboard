import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'

const executablePath = process.env.BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const baseUrl = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173'
const outputDir = '.smoke'
await mkdir(outputDir, { recursive: true })
const browser = await chromium.launch({ executablePath, headless: true })
const failures = []
const scenarios = []
for (const theme of ['light', 'dark']) {
  for (const width of [1440, 1024, 768, 390, 320]) {
    for (const [name, path] of [
      ['fleet', '/#/'],
      ['device', '/#/device/AQ01'],
      ['files', '/#/files'],
      ['settings', '/#/settings'],
    ]) {
      scenarios.push({
        name: `${theme}-${width}-${name}`,
        view: name,
        path,
        theme,
        viewport: { width, height: width > 800 ? 1000 : 844 },
      })
    }
  }
}

for (const scenario of scenarios) {
  const page = await browser.newPage({ viewport: scenario.viewport, deviceScaleFactor: 1 })
  page.setDefaultTimeout(10000)
  await page.addInitScript((theme) => localStorage.setItem('theme', theme), scenario.theme)
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
    if (scenario.view === 'fleet') {
      const search = page.getByRole('textbox', { name: 'Search loggers' })
      await search.fill('no-such-logger')
      await page.getByText('No loggers found').waitFor()
      await search.fill('')
    }
    if (scenario.view === 'device') {
      for (const period of ['6h', '7d', '30d', '24h']) {
        await page.getByRole('button', { name: period, exact: true }).click()
        await page.locator('.chart-card').first().waitFor()
        if ((await page.getByRole('button', { name: period, exact: true }).getAttribute('aria-pressed')) !== 'true')
          throw new Error('Period selection is not announced')
      }
      await page.getByRole('button', { name: 'Refresh list' }).click()
      await page.getByText('Demo catalog refreshed').waitFor()
      await page
        .getByRole('button', { name: /Download AQ01/ })
        .first()
        .click()
      await page.getByRole('dialog').waitFor()
      if (
        !(await page
          .getByRole('button', { name: 'Close', exact: true })
          .evaluate((el) => el === document.activeElement))
      )
        throw new Error('Dialog did not receive keyboard focus')
      await page.keyboard.press('Shift+Tab')
      if (!(await page.getByRole('dialog').evaluate((el) => el.contains(document.activeElement))))
        throw new Error('Focus escaped dialog')
      if (scenario.viewport.width === 390)
        await page.screenshot({ path: `${outputDir}/${scenario.theme}-download-dialog.png` })
      await page.keyboard.press('Escape')
      await page.getByRole('dialog').waitFor({ state: 'hidden' })
    }
    if (scenario.view === 'files') {
      await page.getByRole('textbox', { name: 'Search files' }).fill('2026-09-22')
      await page.getByRole('button', { name: 'Request' }).first().click()
      await page.getByRole('dialog').waitFor()
      await page.keyboard.press('Escape')
    }
    if (scenario.view === 'settings') {
      await page.getByRole('button', { name: 'Save preferences' }).click()
      await page.getByText('Preferences saved on this browser.').waitFor()
    }
    if (scenario.viewport.width <= 800) {
      await page.getByRole('button', { name: 'Open menu' }).click()
      await page.getByRole('link', { name: 'Overview', exact: true }).waitFor({ state: 'visible' })
      await page.keyboard.press('Escape')
      if ((await page.getByRole('button', { name: 'Open menu' }).getAttribute('aria-expanded')) !== 'false')
        throw new Error('Mobile menu did not close')
    }
  } catch (error) {
    failures.push(`${scenario.name}: interaction failure ${error instanceof Error ? error.message : String(error)}`)
  }
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    window.scrollTo(0, 0)
  })
  await page.screenshot({ path: `${outputDir}/${scenario.name}.png`, fullPage: true })
  console.log(`Checked ${scenario.name}`)
  await page.close()
}

await browser.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(
  `Visual checks passed: ${scenarios.length} layouts, both themes, 320–1440px, search, periods, dialogs, keyboard focus, mobile navigation, and preferences`,
)
