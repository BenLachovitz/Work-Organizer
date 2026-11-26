import { downloadBlob } from '@/lib/exportRoster';
import { israelDateTime, type DateKey } from '@/lib/dates';
import { SHIFTS, nominalHours } from '@/lib/shifts';
import type { WeekRoster } from '@/hooks/useGuardPortal';

/** RFC 5545's UTC basic format: YYYYMMDDTHHMMSSZ. */
function toIcsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Escapes the handful of characters ICS text values (e.g. SUMMARY) must not
 *  contain literally -- short Hebrew shift names never need line-folding. */
function icsEscape(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

/**
 * This guard's own upcoming (target_date >= today) shifts across whichever
 * weeks `useVisibleRosters()` currently returns (current + next published
 * week, occasionally last week during the Sunday-morning grace window) --
 * NOT a deep future range, since there is no wider backend query behind this
 * one-time export. A guard who wants a week published further out needs to
 * re-export once it's visible here too.
 *
 * Uses the exact same nominalHours()/israelDateTime() combination already
 * used client-side elsewhere in this app (useWorkLog.ts's nominalWindow(),
 * src/lib/shifts.ts's isShiftActiveAt()) so an exported shift's real window
 * matches what the roster itself displays, including a day12/night12 shift
 * shortened by the week's own double_shift_display_hours setting, and an
 * overnight shift rolling correctly onto the next calendar date.
 */
export function buildShiftsIcs(weeks: WeekRoster[], guardId: string, today: DateKey): string {
  const now = toIcsUtc(new Date());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Work-Organizer//Guard Shifts//HE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:המשמרות שלי',
    'X-WR-TIMEZONE:Asia/Jerusalem',
  ];

  for (const wk of weeks) {
    const mine = wk.assignments
      .filter((a) => a.guard_id === guardId && a.target_date >= today)
      .sort((a, b) => a.target_date.localeCompare(b.target_date));

    for (const a of mine) {
      const { startH, endH } = nominalHours(a.shift, a, wk.assignments, wk.doubleShiftHours);
      const start = israelDateTime(a.target_date, startH);
      const end = israelDateTime(a.target_date, endH);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${a.id}@work-organizer.local`,
        `DTSTAMP:${now}`,
        `DTSTART:${toIcsUtc(start)}`,
        `DTEND:${toIcsUtc(end)}`,
        `SUMMARY:${icsEscape(SHIFTS[a.shift].he)}`,
        'END:VEVENT',
      );
    }
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function shiftsIcsFileName(): string {
  return 'המשמרות-שלי.ics';
}

/** Builds the guard's .ics and triggers the browser download in one call --
 *  same shape exportRoster.ts gives its own page component. */
export function downloadShiftsIcs(weeks: WeekRoster[], guardId: string, today: DateKey): void {
  const ics = buildShiftsIcs(weeks, guardId, today);
  downloadBlob(new Blob([ics], { type: 'text/calendar;charset=utf-8' }), shiftsIcsFileName());
}
