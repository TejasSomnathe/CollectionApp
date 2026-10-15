export function parseRupeesToPaise(value: string): bigint | null {
  const normalized = value.trim()
  if (normalized.length > 17) return null
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!match) return null
  const rupees = BigInt(match[1])
  const paise = BigInt((match[2] ?? '').padEnd(2, '0') || '0')
  const amount = rupees * 100n + paise
  return amount > 0n && amount <= 9000000000000000n ? amount : null
}

export function formatINR(value: number | string | bigint): string {
  const paise = BigInt(value)
  const rupees = paise / 100n
  const remainder = (paise % 100n).toString().padStart(2, '0')
  const digits = rupees.toString()
  const trailing = digits.slice(-3)
  let leading = digits.slice(0, -3)
  const groups: string[] = []
  while (leading.length > 2) {
    groups.unshift(leading.slice(-2))
    leading = leading.slice(0, -2)
  }
  if (leading) groups.unshift(leading)
  return `₹${groups.length ? `${groups.join(',')},${trailing}` : trailing}.${remainder}`
}

export function indiaDateTimeInput(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}

export function indiaTimestamp(input: string): string {
  return new Date(`${input}:00+05:30`).toISOString()
}

export function formatIndiaDate(value: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function escapeCsvCell(value: unknown): string {
  let text = String(value ?? '')
  let firstVisible = 0
  while (firstVisible < text.length && text.charCodeAt(firstVisible) <= 0x20) firstVisible += 1
  if ('=+-@'.includes(text[firstVisible] ?? '\0')) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
