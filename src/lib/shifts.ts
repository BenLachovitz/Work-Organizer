/**
 * Single source of truth for the shift grid, segment coverage and rest rules.
 * Mirrors dynamic-guard-scheduler-spec.md v2.0 sections 2.2 - 2.6, and is
 * mirrored in turn by solver/scheduler.py. Nothing here is duplicated by hand:
 * the rest matrix is DERIVED from the clock times below, so a change to a shift
 * window automatically re-derives every rest classification.
 */

// ---------------------------------------------------------------------------
// Shift catalogue
// ---------------------------------------------------------------------------

export const BASE_SHIFTS = ['morning', 'afternoon', 'night'] as const;
export type BaseShift = (typeof BASE_SHIFTS)[number];

export const SHIFT_TYPES = ['morning', 'afternoon', 'night', 'day12', 'night12'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

export const SEGMENTS = ['S1', 'S2', 'S3', 'S4'] as const;
export type Segment = (typeof SEGMENTS)[number];

// ---------------------------------------------------------------------------
// Working week
//
// This is an American school: Saturday and Sunday are the days off and Friday
// is a normal working day. The roster week still starts on Sunday (index 0),
// which keeps the five working days as a contiguous block 1..5 and lets the UI
// render Sunday-first the way a US calendar does.
// ---------------------------------------------------------------------------

/** Day indices that are days off: Sunday (0) and Saturday (6). */
export const WEEKEND_DAYS = [0, 6] as const;

export function isWeekendDay(dayIndex: number): boolean {
  return dayIndex === 0 || dayIndex === 6;
}

/** Monday..Friday. The only days that can carry the raised morning target. */
export function isWorkingDay(dayIndex: number): boolean {
  return !isWeekendDay(dayIndex);
}

export interface ShiftDef {
  readonly id: ShiftType;
  readonly he: string;
  /** Hours from midnight of the shift's own day. May exceed 24 (night shifts). */
  readonly startH: number;
  readonly endH: number;
  readonly label: string;
  readonly hours: 8 | 12;
  /** True for day12 / night12 -- requires the matching week-level opt-in. */
  readonly isExtended: boolean;
  /** The base availability a guard must have marked to be eligible (spec 3.3). */
  readonly requiresBase: BaseShift;
  readonly covers: readonly Segment[];
  readonly colorVar: string;
}

const H = (h: number, m: number) => h + m / 60;

export const SHIFTS: Record<ShiftType, ShiftDef> = {
  morning: {
    id: 'morning',
    he: 'בוקר',
    startH: H(6, 45),
    endH: H(14, 45),
    label: '06:45-14:45',
    hours: 8,
    isExtended: false,
    requiresBase: 'morning',
    covers: ['S1'],
    colorVar: 'var(--color-shift-morning)',
  },
  afternoon: {
    id: 'afternoon',
    he: 'צהריים',
    startH: H(14, 45),
    endH: H(22, 45),
    label: '14:45-22:45',
    hours: 8,
    isExtended: false,
    requiresBase: 'afternoon',
    covers: ['S2', 'S3'],
    colorVar: 'var(--color-shift-afternoon)',
  },
  night: {
    id: 'night',
    he: 'לילה',
    startH: H(22, 45),
    endH: 24 + H(6, 45),
    label: '22:45-06:45',
    hours: 8,
    isExtended: false,
    requiresBase: 'night',
    covers: ['S4'],
    colorVar: 'var(--color-shift-night)',
  },
  day12: {
    id: 'day12',
    he: 'יום 12ש׳',
    startH: H(6, 45),
    endH: H(18, 45),
    label: '06:45-18:45',
    hours: 12,
    isExtended: true,
    requiresBase: 'morning',
    covers: ['S1', 'S2'],
    colorVar: 'var(--color-shift-day12)',
  },
  night12: {
    id: 'night12',
    he: 'לילה 12ש׳',
    startH: H(18, 45),
    endH: 24 + H(6, 45),
    label: '18:45-06:45',
    hours: 12,
    isExtended: true,
    requiresBase: 'night',
    covers: ['S3', 'S4'],
    colorVar: 'var(--color-shift-night12)',
  },
};

// ---------------------------------------------------------------------------
// Segments (spec 2.3)
//
// The 8h grid (morning|afternoon|night) and the 12h grid (day12|night12) are
// two DIFFERENT partitions of the same 24 hours. Both tile it exactly, on the
// four boundaries 06:45 / 14:45 / 18:45 / 22:45. Enforcing coverage per segment
// rather than per shift is what lets 8h and 12h guards mix freely on one day.
// ---------------------------------------------------------------------------

export interface SegmentDef {
  readonly id: Segment;
  readonly he: string;
  readonly label: string;
  readonly hours: number;
}

export const SEGMENT_DEFS: Record<Segment, SegmentDef> = {
  S1: { id: 'S1', he: 'בוקר', label: '06:45-14:45', hours: 8 },
  S2: { id: 'S2', he: 'צהריים מוקדם', label: '14:45-18:45', hours: 4 },
  S3: { id: 'S3', he: 'צהריים מאוחר', label: '18:45-22:45', hours: 4 },
  S4: { id: 'S4', he: 'לילה', label: '22:45-06:45', hours: 8 },
};

/**
 * How much a segment's floor/target gap should weigh, relative to the
 * shortest segment (4h). A guard missing from S1/S4 (8h) leaves twice the
 * uncovered guard-hours of a guard missing from S2/S3 (4h), but a flat
 * per-slot count can't tell them apart -- which let the solver land on
 * either with the same total objective, arbitrarily. This scales *within*
 * the existing floor(1000)/target(10) tiers (worst case 2x), so it can only
 * decide WHICH segment gets left short in an otherwise-tied trade-off; it
 * never approaches the kamut(100) or rest8(5) tiers.
 */
export function segmentWeight(segment: Segment): number {
  return SEGMENT_DEFS[segment].hours / 4;
}

export type MorningTarget = 2 | 3;

/**
 * The morning target actually in force on a given day.
 *
 * The raised target (3) applies only to working days, Monday to Friday.
 * Saturday and Sunday are days off at the school and always run 2 in the
 * morning no matter what the week is set to.
 */
export function morningTargetForDay(weekSetting: MorningTarget, dayIndex: number): number {
  return isWorkingDay(dayIndex) ? weekSetting : 2;
}

/**
 * Ceiling per segment for one day. The solver never staffs above this (H6).
 *
 * dayIndex is required rather than optional on purpose: every caller has to
 * state which day it means, so a site that forgets the weekend rule fails to
 * compile instead of silently over-staffing Saturday.
 */
export function segmentTargets(
  weekSetting: MorningTarget,
  dayIndex: number,
): Record<Segment, number> {
  return { S1: morningTargetForDay(weekSetting, dayIndex), S2: 2, S3: 2, S4: 2 };
}

/** Critical floor per segment (spec 2.4). Soft, but penalised at weight 1000. */
export function segmentFloors(
  weekSetting: MorningTarget,
  dayIndex: number,
): Record<Segment, number> {
  const morning = morningTargetForDay(weekSetting, dayIndex);
  return { S1: morning === 3 ? 2 : 1, S2: 1, S3: 1, S4: 1 };
}

/** Which shift types contribute coverage to a given segment. */
export function shiftsCovering(segment: Segment): ShiftType[] {
  return SHIFT_TYPES.filter((s) => SHIFTS[s].covers.includes(segment));
}

// ---------------------------------------------------------------------------
// Rest rules (spec 2.6)
//
//   < 8h   impossible, hard-blocked  (this is where No-Clopen comes from:
//                                     night -> next morning is 0h)
//   = 8h   permitted but penalised -5
//   >= 12h free
// ---------------------------------------------------------------------------

export const HARD_REST_HOURS = 8;
export const FREE_REST_HOURS = 12;

export type RestClass = 'blocked' | 'penalised' | 'free';

/** Rest between a shift on day d and a shift on day d+1. */
export function restHours(prev: ShiftType, next: ShiftType): number {
  return 24 + SHIFTS[next].startH - SHIFTS[prev].endH;
}

export function classifyRest(prev: ShiftType, next: ShiftType): RestClass {
  const r = restHours(prev, next);
  if (r < HARD_REST_HOURS) return 'blocked';
  if (r < FREE_REST_HOURS) return 'penalised';
  return 'free';
}

/** Precomputed matrix for UI badges and the validator. */
export const REST_MATRIX: Record<ShiftType, Record<ShiftType, RestClass>> = Object.fromEntries(
  SHIFT_TYPES.map((p) => [
    p,
    Object.fromEntries(SHIFT_TYPES.map((n) => [n, classifyRest(p, n)])),
  ]),
) as Record<ShiftType, Record<ShiftType, RestClass>>;

/** True when `next` on day d+1 is illegal after `prev` on day d. */
export function isRestViolation(prev: ShiftType, next: ShiftType): boolean {
  return classifyRest(prev, next) === 'blocked';
}

// ---------------------------------------------------------------------------
// Eligibility (spec 3.3)
// ---------------------------------------------------------------------------

/** Which days a guard will extend, per extended shift type. */
export interface TwelveHourOptIns {
  day: readonly number[];
  night: readonly number[];
}

/**
 * A guard may be assigned `shift` on `dayIndex` only if they marked the
 * underlying base shift for that day AND, for the extended grid, opted that
 * specific day in. The opt-in is per day, not per week.
 */
export function isEligible(
  shift: ShiftType,
  dayIndex: number,
  markedBaseShifts: readonly BaseShift[],
  optIns: TwelveHourOptIns,
): boolean {
  const def = SHIFTS[shift];
  if (!markedBaseShifts.includes(def.requiresBase)) return false;
  if (shift === 'day12') return optIns.day.includes(dayIndex);
  if (shift === 'night12') return optIns.night.includes(dayIndex);
  return true;
}

// ---------------------------------------------------------------------------
// Weekly limits (spec 2.7)
// ---------------------------------------------------------------------------

export const MAX_SHIFTS_PER_WEEK = 5;

/**
 * Pre-flight כמות override. A guard who marked only 2 days can never reach a
 * כמות of 4, so we lower the target instead of handing the solver a constraint
 * it cannot satisfy. This is what prevents unexplainable INFEASIBLE results.
 */
export function effectiveKamut(configuredKamut: number, distinctAvailableDays: number): number {
  return Math.max(0, Math.min(configuredKamut, distinctAvailableDays, MAX_SHIFTS_PER_WEEK));
}

// ---------------------------------------------------------------------------
// Objective weights (spec 4.2)
// ---------------------------------------------------------------------------

export const WEIGHTS = {
  floor: 1000,
  kamut: 100,
  target: 10,
  rest8: 5,
  pref: 1,
  /** Added on top of `pref` for a guard's עדיפות-marked slot. Deliberately
   *  small: 1 (pref) + 2 (preferred) = 3, still well under rest8 (5) and
   *  target (10), so it can only break ties, never outweigh a real rule.
   *
   *  Measured trade-off (see git history around this line): raising this to
   *  50 -- enough to reliably win an ordinary coverage trade-off -- bought
   *  one guard's last preferred shift at the cost of two EXTRA 8h-rest
   *  occurrences elsewhere in the roster on the one real dataset tested,
   *  for no change in total target-gap count. At 2, the same guard still
   *  got 4 of 5 preferred shifts with zero cost anywhere. Don't raise this
   *  without re-measuring on real data the way that comparison did. */
  preferred: 2,
} as const;
