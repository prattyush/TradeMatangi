/** Number and date formatting for the phone screens. Dates are IST calendar dates ("2026-11-09"), shown as written. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** "2026-11-09" -> { day: "09", month: "Nov", weekday: "Mon", year: "2026" } without any timezone shift. */
export function dateParts(date: string): { day: string; month: string; weekday: string; year: string } {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return { day: date, month: '', weekday: '', year: '' }
  return {
    day: String(day).padStart(2, '0'),
    month: MONTHS[month - 1] ?? '',
    weekday: WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()],
    year: String(year),
  }
}

const money = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const moneyCents = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** "+₹1,240" / "-₹850" / "₹0" */
export function formatPnl(value: number, cents = false): string {
  const formatter = cents ? moneyCents : money
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}₹${formatter.format(Math.abs(value))}`
}

export const pnlClass = (value: number): 'pos' | 'neg' | 'flat' => (value > 0 ? 'pos' : value < 0 ? 'neg' : 'flat')

export function modeLabel(sessionType: string): string {
  switch (sessionType) {
    case 'real': return 'Real'
    case 'paper': return 'Paper'
    case 'stepwise': return 'Stepwise'
    case 'sim': case 'replay': return 'Replay'
    default: return sessionType ? sessionType[0].toUpperCase() + sessionType.slice(1) : 'Replay'
  }
}

export const instrumentLabel = (instrumentType: string): string =>
  instrumentType === 'options' ? 'Options' : instrumentType === 'futures' ? 'Futures' : 'Equity'

/** IST wall-clock time from a trade timestamp (the backend stores IST-as-UTC epoch seconds). */
export function clockTime(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}
