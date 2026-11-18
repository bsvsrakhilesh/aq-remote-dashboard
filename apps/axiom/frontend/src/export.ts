/** Quote every cell and neutralize spreadsheet formulas in untrusted labels. */
export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value)
  if (typeof value === 'string' && /^[\s]*[=+@-]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

export function downloadFile(filename: string, contents: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename.replace(/[^a-zA-Z0-9._-]/g, '-')
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function exportAnalysis(filename: string, configuration: unknown, results: unknown) {
  downloadFile(filename, JSON.stringify({
    application: 'Axiom', schema_version: 1, exported_at: new Date().toISOString(),
    configuration, results,
    note: 'Exploratory analysis. Review assumptions and data quality before drawing conclusions.',
  }, null, 2))
}
