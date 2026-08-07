/**
 * Date helpers pinned to the Israeli work week and Asia/Jerusalem.
 *
 * Dates are handled as 'YYYY-MM-DD' strings and constructed at UTC midnight.
 * Using local-midnight Date objects here would shift the whole roster by a day
 * for anyone whose device is west of UTC, which is exactly the class of bug
 * that makes a scheduling app untrustworthy.
 */

export const ISRAEL_TZ = 'Asia/Jerusalem';

/** Sunday-first, matching solver day indices 0..6. */
export const HEBREW_DAYS = [
  'ראשון',
  'שני',
  'שלישי',
  'רביעי',
  'חמישי',
  'שישי',
  'שבת',
] as const;

export const HEBREW_DAYS_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'] as const;

export type DateKey = string; // 'YYYY-MM-DD'

const MS_PER_DAY = 86_400_000;

/** Parse 'YYYY-MM-DD' at UTC midnight. */
export function parseDateKey(key: DateKey): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

export function toDateKey(date: Date): DateKey {
  return date.toISOString().slice(0, 10);
}

export function addDays(key: DateKey, days: number): DateKey {
  return toDateKey(new Date(parseDateKey(key).getTime() + days * MS_PER_DAY));
}

/** 0 = Sunday .. 6 = Saturday. */
export function dayIndex(key: DateKey): number {
  return parseDateKey(key).getUTCDay();
}

/** The Sunday on or before `key`. */
export function weekStartOf(key: DateKey): DateKey {
  return addDays(key, -dayIndex(key));
}

/** The 7 date keys of a roster week, Sunday first. */
export function weekDates(weekStart: DateKey): DateKey[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Today's date key as observed in Israel, regardless of device timezone. */
export function todayInIsrael(): DateKey {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ISRAEL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * The roster week currently open for submissions: the earliest upcoming week
 * whose Wednesday 19:00 deadline has not yet passed.
 *
 * Naively returning "next Sunday's week" is wrong from Wednesday 19:00 onward --
 * that week's window has already closed, so the guard would be shown a locked
 * form with nothing to do. Once the deadline passes we roll forward to the next
 * week, which is the one they can actually still submit for.
 */
export function currentSubmissionWeek(now: Date = new Date()): DateKey {
  let candidate = addDays(weekStartOf(todayInIsrael()), 7);
  // At most two rolls: the deadline sits 4 days before its own week start.
  for (let i = 0; i < 3; i++) {
    if (submissionDeadline(candidate).getTime() > now.getTime()) return candidate;
    candidate = addDays(candidate, 7);
  }
  return candidate;
}

/** Whether the submission window for `weekStart` is still open. */
export function isSubmissionOpen(weekStart: DateKey, now: Date = new Date()): boolean {
  return submissionDeadline(weekStart).getTime() > now.getTime();
}

/** Submissions close this many days before the roster week starts. */
export const DEADLINE_DAYS_BEFORE = 4; // Sunday start - 4 = the Wednesday before
export const DEADLINE_HOUR = 19;

/**
 * Submissions close on the Wednesday before the roster week, at 19:00 local
 * (spec 3.5). week_start is a Sunday, so that Wednesday is week_start - 4.
 *
 * Built by asking Intl what the UTC offset is on that specific date rather than
 * assuming +03, so the value stays correct across the IDT/IST changeover.
 */
export function submissionDeadline(weekStart: DateKey): Date {
  const wednesday = addDays(weekStart, -DEADLINE_DAYS_BEFORE);
  const [y, m, d] = wednesday.split('-').map(Number);
  const naiveUtc = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, DEADLINE_HOUR, 0, 0);
  // Offset that Asia/Jerusalem is running at on that date.
  const probe = new Date(naiveUtc);
  const local = new Date(probe.toLocaleString('en-US', { timeZone: ISRAEL_TZ }));
  const utc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }));
  return new Date(naiveUtc - (local.getTime() - utc.getTime()));
}

export function formatDeadline(deadline: Date): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: ISRAEL_TZ,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(deadline);
}

/** e.g. "9 באוגוסט" */
export function formatDayMonth(key: DateKey): string {
  return new Intl.DateTimeFormat('he-IL', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
  }).format(parseDateKey(key));
}

/** e.g. "9-15 באוגוסט 2026" */
export function formatWeekRange(weekStart: DateKey): string {
  const end = addDays(weekStart, 6);
  const dayOf = (k: DateKey) => parseDateKey(k).getUTCDate();
  const monthYear = new Intl.DateTimeFormat('he-IL', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(parseDateKey(end));
  return `${dayOf(weekStart)}-${dayOf(end)} ב${monthYear}`;
}

/** Human countdown, e.g. "יומיים ו-3 שעות". Returns null once passed. */
export function timeUntil(deadline: Date, now: Date = new Date()): string | null {
  const ms = deadline.getTime() - now.getTime();
  if (ms <= 0) return null;

  const totalHours = Math.floor(ms / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;

  if (days === 0) {
    if (totalHours === 0) return `${Math.max(1, Math.floor(ms / 60_000))} דקות`;
    return `${totalHours} שעות`;
  }
  const dayPart = days === 1 ? 'יום' : days === 2 ? 'יומיים' : `${days} ימים`;
  return hours > 0 ? `${dayPart} ו-${hours} שעות` : dayPart;
}
