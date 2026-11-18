import { test, expect } from '@playwright/test'
import { csvCell } from '../src/export'

test('CSV exports escape labels and neutralize formulas without changing numeric negatives', () => {
  expect(csvCell('Sensor "A", North')).toBe('"Sensor ""A"", North"')
  expect(csvCell('=HYPERLINK("https://example.test")')).toBe('"\'=HYPERLINK(""https://example.test"")"')
  expect(csvCell('  +SUM(A1:A2)')).toBe('"\'  +SUM(A1:A2)"')
  expect(csvCell(-12.5)).toBe('"-12.5"')
  expect(csvCell(null)).toBe('""')
})
