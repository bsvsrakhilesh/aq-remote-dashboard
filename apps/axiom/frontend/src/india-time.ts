const IST_OFFSET_MS = 330 * 60_000
const istDateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

export function utcInstant(value: string | number | Date): Date {
  if (typeof value !== 'string') return new Date(value)
  return new Date(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`)
}

export function istIso(value: string | number | Date): string {
  return new Date(utcInstant(value).getTime() + IST_OFFSET_MS).toISOString().slice(0, 19) + '+05:30'
}

export function formatIst(value: string | number | Date): string {
  return `${istDateTime.format(utcInstant(value))} IST`
}
