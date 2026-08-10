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

/**
 * segmentWeight() plus a flat morning-specific priority bonus, for use ONLY
 * in the floor/target penalty terms of the objective (P1/P3) -- never for the
 * coverage NUMBERS themselves (segmentTargets/segmentFloors, unaffected). Per
 * Ben: the manager's actual preference is a fully-staffed morning over a
 * balanced morning/night when a trade-off is unavoidable -- e.g. one guard
 * alone at night rather than splitting a flexible guard's availability
 * evenly. Making an unfilled S1 slot cost strictly more than an unfilled S4
 * slot (both already 2x S2/S3 from length alone, see segmentWeight above)
 * achieves exactly that: the solver naturally routes a guard marked for both
 * morning and another shift toward morning whenever morning coverage
 * actually needs it, and leaves them free for the other shift once it
 * doesn't -- without touching a guard's own עדיפות mark, which lives in the
 * much smaller P4b tier and only ever breaks a tie the coverage tiers (P1
 * ×1000, P3 ×10) have already left open.
 *
 * ADDITIVE, not a multiplier -- like every other weight in this system
 * (floor/kamut/target/rest8/pref/preferred/stretch are all plain integers).
 * CP-SAT's coefficients must be integers; a float multiplier would need a
 * rounding step in scheduler.py that the TS mock/referee wouldn't share,
 * which is exactly the kind of engine divergence this project's fixture
 * discipline exists to catch. `morningPriorityBonus` is passed in rather than
 * read from WEIGHTS directly so every caller flows it through input.weights
 * like every other weight -- consistent with how w.pref/w.floor/etc. already
 * work, and what lets preview:cpsat try a different value against live data
 * without editing code.
 */
export function segmentPenaltyWeight(segment: Segment, morningPriorityBonus: number): number {
  return segment === 'S1' ? segmentWeight(segment) + morningPriorityBonus : segmentWeight(segment);
}

export type MorningTarget = 2 | 3;

/**
 * A week-specific exception to the week's own morningTarget, for individual
 * weekdays (day index 1-5, Mon-Fri) -- e.g. a holiday week needing Mon-Wed at
 * 2 guards but Thu-Fri at 3. Sparse: a day with no entry just follows the
 * week's own setting. Keyed by day index AS A STRING because this travels
 * over JSON (weekly_morning_target_overrides rows, the solver contract) where
 * object keys are always strings; morningTargetForDay() below does the
 * lookup so callers never have to think about the key type themselves.
 */
export type MorningTargetOverrides = Partial<Record<string, MorningTarget>>;

/**
 * The morning target actually in force on a given day.
 *
 * The raised target (3) applies only to working days, Monday to Friday.
 * Saturday and Sunday are days off at the school and always run 2 in the
 * morning no matter what the week is set to -- an override never applies to
 * them, even if one somehow existed for that index.
 *
 * `overrides` beats `weekSetting` for a day that has one -- see
 * MorningTargetOverrides for why this is sparse rather than a full 5-day map.
 */
export function morningTargetForDay(
  weekSetting: MorningTarget,
  dayIndex: number,
  overrides?: MorningTargetOverrides,
): number {
  if (!isWorkingDay(dayIndex)) return 2;
  return overrides?.[String(dayIndex)] ?? weekSetting;
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
  overrides?: MorningTargetOverrides,
): Record<Segment, number> {
  return { S1: morningTargetForDay(weekSetting, dayIndex, overrides), S2: 2, S3: 2, S4: 2 };
}

/** Critical floor per segment (spec 2.4). Soft, but penalised at weight 1000. */
export function segmentFloors(
  weekSetting: MorningTarget,
  dayIndex: number,
  overrides?: MorningTargetOverrides,
): Record<Segment, number> {
  const morning = morningTargetForDay(weekSetting, dayIndex, overrides);
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
 * The highest number of shifts ANY guard may ever reach in a week -- one
 * more than the ordinary ceiling. Only reachable by a guard already AT the
 * ordinary ceiling (configuredKamut === MAX_SHIFTS_PER_WEEK) who explicitly
 * asks for one more; see maxRequestableShifts() below. Every other guard's
 * hard ceiling stays exactly MAX_SHIFTS_PER_WEEK, request or not.
 */
export const ABSOLUTE_MAX_SHIFTS_PER_WEEK = 6;

/**
 * The highest a guard's own request could ever raise their ceiling to.
 * Ordinarily MAX_SHIFTS_PER_WEEK; only a guard already configured at that
 * ordinary ceiling gets ABSOLUTE_MAX_SHIFTS_PER_WEEK instead -- the "a 5-כמות
 * guard may ask for a 6th shift, nobody else" rule. Whether they actually
 * reach it is still entirely up to guardShiftCeiling() (guaranteed, only on
 * an explicit LOWER request) or stretchTarget()/WEIGHTS.stretch (a soft
 * bonus, only on an explicit HIGHER request) -- this only says how far up
 * either of those is allowed to go, and is also what both stepper UIs
 * (WeeklyPreferenceForm.tsx, GuardPreferenceEditor.tsx) show as the max.
 */
export function maxRequestableShifts(configuredKamut: number): number {
  return configuredKamut === MAX_SHIFTS_PER_WEEK
    ? ABSOLUTE_MAX_SHIFTS_PER_WEEK
    : MAX_SHIFTS_PER_WEEK;
}

/**
 * Pre-flight כמות override. A guard who marked only 2 days can never reach a
 * כמות of 4, so we lower the target instead of handing the solver a constraint
 * it cannot satisfy. This is what prevents unexplainable INFEASIBLE results.
 *
 * `requestedShifts` is the guard's own stated preference for the week
 * (`weekly_submissions.requested_shifts`, nullable). It only ever LOWERS the
 * penalized floor, never raises it: a request below configured wins outright
 * (`min(configured, requested)`), a request at or above configured leaves
 * configured as the floor unchanged -- a higher request only ever earns a
 * soft, non-penalized bonus via `stretchTarget()` below, it never becomes
 * something the solver is penalized for missing.
 */
export function effectiveKamut(
  configuredKamut: number,
  distinctAvailableDays: number,
  requestedShifts?: number | null,
): number {
  const floorTarget =
    requestedShifts != null && requestedShifts < configuredKamut ? requestedShifts : configuredKamut;
  return Math.max(0, Math.min(floorTarget, distinctAvailableDays, MAX_SHIFTS_PER_WEEK));
}

/**
 * A guard's hard weekly ceiling -- the actual H4 cap the solver may never
 * cross, distinct from effectiveKamut() (a soft floor the solver is only
 * penalized for missing, never stopped from exceeding). Ordinarily this is
 * just the flat MAX_SHIFTS_PER_WEEK everyone shares. But a guard who
 * explicitly asked for FEWER shifts than configured is stating a personal
 * constraint, not a manager target -- the same kind of thing H1 (availability)
 * already is -- so it tightens the ceiling itself, guaranteeing the request is
 * never exceeded even when the roster would otherwise benefit from it.
 *
 * A request for MORE than configured ordinarily never reaches this function
 * at all -- it only feeds stretchTarget()'s soft bonus below, so the "ask for
 * more" path can never accidentally tighten anyone's hard ceiling. The one
 * exception is the guard already AT the ordinary ceiling (configuredKamut
 * === MAX_SHIFTS_PER_WEEK): for them alone, an explicit request for a 6th
 * shift raises the hard ceiling just enough to let stretchTarget()'s soft
 * bonus actually reach it -- the ceiling move itself grants nothing, it only
 * permits the existing soft mechanism to work past 5 for this one case.
 */
export function guardShiftCeiling(
  configuredKamut: number,
  distinctAvailableDays: number,
  requestedShifts: number | null | undefined,
): number {
  if (requestedShifts != null && requestedShifts < configuredKamut) {
    return effectiveKamut(configuredKamut, distinctAvailableDays, requestedShifts);
  }
  if (requestedShifts != null && requestedShifts > configuredKamut) {
    return Math.min(requestedShifts, maxRequestableShifts(configuredKamut));
  }
  return MAX_SHIFTS_PER_WEEK;
}

/**
 * The rewarded (never penalized) ceiling for a guard who asked for MORE than
 * their configured כמות -- always >= effectiveKamut(). Feeds the solver's
 * soft "stretch" bonus (WEIGHTS.stretch), which mirrors how the עדיפות bonus
 * (WEIGHTS.preferred) sits on top of the flat preference term: additive, not
 * a new priority tier, weighted low enough it can only win a trade the rest
 * of the objective is already indifferent to.
 *
 * The reachable ceiling is maxRequestableShifts(configuredKamut) -- ordinarily
 * MAX_SHIFTS_PER_WEEK, or ABSOLUTE_MAX_SHIFTS_PER_WEEK for a guard already
 * configured at that ordinary ceiling asking for one more. Getting there
 * still requires guardShiftCeiling() to have raised the guard's actual hard
 * cap to match (only true for that same 5-configured case) -- this function
 * only ever computes the reward target, never the enforcement.
 */
export function stretchTarget(
  configuredKamut: number,
  distinctAvailableDays: number,
  requestedShifts: number | null | undefined,
): number {
  const eff = effectiveKamut(configuredKamut, distinctAvailableDays, requestedShifts);
  if (requestedShifts == null || requestedShifts <= configuredKamut) return eff;
  return Math.max(
    eff,
    Math.min(requestedShifts, distinctAvailableDays, maxRequestableShifts(configuredKamut)),
  );
}

/**
 * The best shift count actually achievable from a set of marked slots alone,
 * respecting the same >=8h rest rule the solver enforces (H5) -- marking
 * Sunday night and Monday morning has NOT bought two shifts, since the two
 * can never legally combine (0h rest, blocked). Shown to a guard as "משמרות
 * אפשריות מהסימונים שלך" (WeeklyPreferenceForm.tsx) and reused, live, as the
 * ceiling on the requested-shifts stepper in both that form and the manager's
 * GuardPreferenceEditor -- which is why this lives here rather than as a
 * component-local helper: both need the identical calculation, recomputed
 * against whatever slots are CURRENTLY toggled, not just an initial snapshot.
 *
 * Small DP over the week: for each day, the best count ending in "worked
 * shift S" is 1 + the best count from the previous day that isn't blocked by
 * resting into S (or the best "day off" count, always compatible). Extended
 * (12h) shifts aren't modelled separately -- this is a guidance number, not
 * solver input.
 *
 * `isMarked` is a predicate rather than a `Selection` map so callers with
 * different underlying data shapes (a Map keyed by "date|shift", or rows
 * freshly read from the database) can each pass their own lookup without
 * this file needing to import a UI-layer type.
 *
 * Deliberately NOT clamped to MAX_SHIFTS_PER_WEEK (or anyone's requestable
 * ceiling) here -- this is purely a physical fact about the marked slots
 * (7 nights in a row rests fine, so it can legitimately answer 7), and
 * baking a policy ceiling into a "fact" function would silently misreport
 * it for whichever guard that ceiling doesn't apply to. Callers that need a
 * selectable maximum (the requested-shifts stepper) combine this with
 * maxRequestableShifts() themselves -- see WeeklyPreferenceForm.tsx and
 * GuardPreferenceEditor.tsx.
 */
export function maxFeasibleShifts(
  dates: readonly string[],
  isMarked: (date: string, shift: BaseShift) => boolean,
): number {
  const DAY_OFF = Symbol('off');
  let prev = new Map<BaseShift | typeof DAY_OFF, number>([[DAY_OFF, 0]]);
  for (const date of dates) {
    const options = BASE_SHIFTS.filter((s) => isMarked(date, s));
    const bestSoFar = Math.max(...prev.values());
    const next = new Map<BaseShift | typeof DAY_OFF, number>([[DAY_OFF, bestSoFar]]);
    for (const shift of options) {
      let best = prev.get(DAY_OFF) ?? 0;
      for (const [prevShift, count] of prev) {
        if (prevShift === DAY_OFF) continue;
        if (classifyRest(prevShift, shift) !== 'blocked') best = Math.max(best, count);
      }
      next.set(shift, best + 1);
    }
    prev = next;
  }
  return Math.max(...prev.values());
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
  /** Bonus for a shift beyond a guard's effective כמות, up to their own
   *  stretchTarget() -- the guard-requested-shift-count analogue of
   *  `preferred`, same additive-not-a-new-tier shape. Starting value only:
   *  unlike `preferred`, this has not yet been measured against live data
   *  (see the `preferred` weight-tuning story above for the methodology to
   *  repeat before treating 1 as final -- solve a real week before/after a
   *  guard requests extra shifts and confirm it only ever wins a trade
   *  nothing else cares about). */
  stretch: 1,
  /** Flat bonus ADDED to segmentWeight('S1') ONLY, in the floor/target
   *  penalty terms (P1/P3) -- see segmentPenaltyWeight() above for the
   *  mechanism and full rationale. 0 would mean "no priority beyond S1's
   *  existing length-based weight of 2" (identical to S4's); 1 makes an
   *  unfilled S1 slot cost 3 (floor) / 3 (target) where S4 still costs 2.
   *  Named snake_case, unlike the rest of this file, because this object's
   *  keys are the wire format itself (solverWeightsSchema/SolverWeights
   *  parse it directly via `.default(WEIGHTS)`) -- not idiomatic TS naming.
   *
   *  Starting hypothesis, not yet measured against live data -- ship this the
   *  same way WEIGHTS.stretch shipped (see that comment): solve a real week
   *  before/after with `npm run preview:cpsat`, on a case where a guard is
   *  genuinely flexible between morning and another shift, and confirm
   *  morning wins the trade-off without costing an extra floor breach or 8h
   *  rest occurrence elsewhere. Raise or lower from 1 only after that
   *  comparison, the same discipline §3.8/§4.2a's weight stories used. */
  morning_priority: 1,
} as const;
