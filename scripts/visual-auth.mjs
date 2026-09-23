import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'

// Isolate the login presentation from production credentials and network writes.
const baseUrl = process.env.SMOKE_URL ?? 'http://127.0.0.1:5173'
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  headless: true,
})
await mkdir('.smoke', { recursive: true })
try {
  for (const width of [1440, 768, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } })
    await page.route('**/src/services/supabase.ts', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `export const demoMode = false; export const readOnlyMode = false; export const appName = 'AQ Observatory'; export const supabase = { auth: { getSession: async () => ({data: {session: null}}), onAuthStateChange: () => ({data: {subscription: {unsubscribe() {}}}}), signInWithPassword: async () => ({error: {status: 400}}) } };`,
      }),
    )
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByRole('heading', { name: 'Welcome back' }).waitFor()
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error(`Login overflows at ${width}px`)
    await page.screenshot({ path: `.smoke/login-${width}.png`, fullPage: true })
    await page.getByLabel('Email address').fill('ui-check@example.test')
    await page.getByLabel('Password', { exact: true }).fill('ui-check-only')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('alert').filter({ hasText: 'Email or password is incorrect.' }).waitFor()
    await page.screenshot({ path: `.smoke/login-error-${width}.png`, fullPage: true })
    await page.close()
    console.log(`Login and error presentation passed at ${width}px (mock authentication)`)
  }
} finally {
  await browser.close()
}
