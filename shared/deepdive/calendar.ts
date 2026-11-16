/** Month grids for the Deep Dive date picker. Pure and time-zone free: dates are `YYYY-MM-DD` strings. */

export interface MonthRef { year: number; month: number } // month 1-12
export interface CalendarCell { date: string; day: number; inMonth: boolean }

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDate = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`

/** 0 Sunday … 6 Saturday. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

export const isWeekend = (date: string) => [0, 6].includes(weekdayOf(date))

/** Today in the user's own calendar (not UTC), as `YYYY-MM-DD`. */
export const todayIso = (now: Date = new Date()) => isoDate(now.getFullYear(), now.getMonth() + 1, now.getDate())

export const monthOf = (date: string): MonthRef => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) })

export function shiftMonth(ref: MonthRef, delta: number): MonthRef {
  const index = ref.year * 12 + (ref.month - 1) + delta
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const monthLabel = (ref: MonthRef) => `${MONTH_NAMES[ref.month - 1]} ${ref.year}`

/** Weeks (Monday first) covering the month; days of neighbouring months fill the first and last week. */
export function monthGrid(ref: MonthRef): CalendarCell[][] {
  const first = isoDate(ref.year, ref.month, 1)
  const lead = (weekdayOf(first) + 6) % 7 // Monday = 0
  const length = new Date(Date.UTC(ref.year, ref.month, 0)).getUTCDate()
  const cells: CalendarCell[] = []
  for (let offset = -lead; cells.length % 7 !== 0 || offset < length; offset += 1) {
    const stamp = new Date(Date.UTC(ref.year, ref.month - 1, 1 + offset))
    cells.push({
      date: isoDate(stamp.getUTCFullYear(), stamp.getUTCMonth() + 1, stamp.getUTCDate()),
      day: stamp.getUTCDate(),
      inMonth: offset >= 0 && offset < length,
    })
  }
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7))
}

/** A day can hold a setup when it is a weekday before today (holidays are checked by the server). */
export const pickableDay = (date: string, today: string) => !isWeekend(date) && date < today

/** The latest weekday before `today`: where a new deep dive's calendar opens. */
export function lastPickableDay(today: string): string {
  let [year, month, day] = today.split('-').map(Number)
  for (let step = 0; step < 7; step += 1) {
    const stamp = new Date(Date.UTC(year, month - 1, day - 1))
    ;[year, month, day] = [stamp.getUTCFullYear(), stamp.getUTCMonth() + 1, stamp.getUTCDate()]
    if (!isWeekend(isoDate(year, month, day))) break
  }
  return isoDate(year, month, day)
}
