import { z } from 'zod';
import {
  BASE_SHIFTS,
  SHIFT_TYPES,
  SEGMENTS,
  WEIGHTS,
  MAX_SHIFTS_PER_WEEK,
  ABSOLUTE_MAX_SHIFTS_PER_WEEK,
} from '@/lib/shifts';

/**
 * The wire contract between the app and the scheduling engine.
 *
 * Mirrored by solver/models.py. Neither side is generated from the other --
 * what actually keeps them honest is solver/tests/fixtures/*.json: both engines
 * must parse every fixture and produce output that passes the SAME verifier
 * (src/lib/validate.ts and its Python twin). A drift in either direction shows
 * up as a fixture failure rather than a runtime surprise.
 */

export const baseShiftSchema = z.enum(BASE_SHIFTS);
export const shiftTypeSchema = z.enum(SHIFT_TYPES);
export const segmentSchema = z.enum(SEGMENTS);

export const solverWeightsSchema = z.object({
  floor: z.number().int().nonnegative(),
  kamut: z.number().int().nonnegative(),
  target: z.number().int().nonnegative(),
  rest8: z.number().int().nonnegative(),
  pref: z.number().int().nonnegative(),
  /** Added on top of `pref` for a slot the guard marked עדיפות (strength 2).
   *  A minor tie-breaker only -- stays below rest8 and target so it can never
   *  cause a floor breach, an unmet כמות, or an extra rest penalty just to
   *  honour a preference (measured trade-off: see the comment on WEIGHTS in
   *  src/lib/shifts.ts). Defaulted, like the Python twin, so a fixture or
   *  caller written before this existed still parses. */
  preferred: z.number().int().nonnegative().default(2),
  /** Bonus for a shift beyond a guard's effective_kamut, up to their own
   *  stretch_target -- the guard-requested-shift-count analogue of
   *  `preferred`. Defaulted, like the Python twin, so a fixture or caller
   *  written before this existed still parses. */
  stretch: z.number().int().nonnegative().default(1),
});

export const solverGuardSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  /** Already lowered by min(configured, available_days, 5) before it gets here. */
  effective_kamut: z.number().int().min(0).max(5),
  /** The rewarded (never penalized) ceiling for this guard -- intended to
   *  always be >= effective_kamut when both are set meaningfully. Already
   *  computed upstream (stretchTarget() in src/lib/shifts.ts) from the
   *  guard's own requested shift count; the solver only ever sees these two
   *  pre-derived numbers, never the raw request or configured_kamut.
   *  Defaults to 0 so a fixture/caller written before this existed still
   *  parses -- both engines clamp the derived bonus cap at 0 rather than
   *  going negative if a caller sends effective_kamut > stretch_target. */
  stretch_target: z.number().int().min(0).max(6).default(0),
  /** This guard's hard weekly ceiling (H4) -- ordinarily the flat 5-shift
   *  cap everyone shares, but tightened to the guard's own requested count
   *  when they explicitly asked for FEWER shifts than configured, or (only
   *  for a guard already configured at the ordinary ceiling) raised to 6
   *  when they explicitly asked for one more (guardShiftCeiling() in
   *  src/lib/shifts.ts). Defaults to MAX_SHIFTS_PER_WEEK so a fixture/caller
   *  written before this existed still parses to today's unchanged
   *  behaviour. */
  max_shifts: z.number().int().min(0).max(ABSOLUTE_MAX_SHIFTS_PER_WEEK).default(MAX_SHIFTS_PER_WEEK),
  /** Day index "0".."6" (Sunday-first) -> the base shifts they marked. */
  availability: z.record(z.string(), z.array(baseShiftSchema)),
  /** Day index -> the base shifts marked עדיפות (strength 2) that day.
   *  Always a subset of `availability` for the same day -- a shift cannot be
   *  preferred without being marked available first. */
  preferred: z.record(z.string(), z.array(baseShiftSchema)).default({}),
  /**
   * Day indices on which the guard will extend to a 12h shift. Per day, not
   * per week: someone can be willing to do a long Monday and a short Tuesday.
   * Eligibility is the AND of availability and this list --
   *   day12 on day d  <=>  'morning' in availability[d] and d in twelve_hour_day
   */
  twelve_hour_day: z.array(z.number().int().min(0).max(6)).default([]),
  twelve_hour_night: z.array(z.number().int().min(0).max(6)).default([]),
});

export const solverInputSchema = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  morning_target_slots: z.union([z.literal(2), z.literal(3)]),
  guards: z.array(solverGuardSchema),
  /** guard_id -> the shift they worked LAST Saturday, for cross-week rest. */
  carry_in: z.record(z.string(), shiftTypeSchema.nullable()).default({}),
  weights: solverWeightsSchema.default(WEIGHTS),
});

export const assignmentSchema = z.object({
  day: z.number().int().min(0).max(6),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shift: shiftTypeSchema,
  guard_id: z.string().min(1),
});

export const coverageReportSchema = z.object({
  floor_breaches: z.array(
    z.object({
      day: z.number().int(),
      segment: segmentSchema,
      required: z.number().int(),
      assigned: z.number().int(),
    }),
  ),
  target_gaps: z.array(
    z.object({
      day: z.number().int(),
      segment: segmentSchema,
      target: z.number().int(),
      assigned: z.number().int(),
    }),
  ),
  unmet_kamut: z.array(
    z.object({
      guard_id: z.string(),
      effective_kamut: z.number().int(),
      assigned: z.number().int(),
    }),
  ),
  rest_violations: z.array(
    z.object({
      guard_id: z.string(),
      day: z.number().int(),
      from: shiftTypeSchema,
      to: shiftTypeSchema,
      hours: z.number(),
    }),
  ),
});

export const solverOutputSchema = z.object({
  status: z.string(),
  objective_value: z.number(),
  assignments: z.array(assignmentSchema),
  coverage_report: coverageReportSchema,
});

export type SolverWeights = z.infer<typeof solverWeightsSchema>;
export type SolverGuard = z.infer<typeof solverGuardSchema>;
export type SolverInput = z.infer<typeof solverInputSchema>;
export type Assignment = z.infer<typeof assignmentSchema>;
export type CoverageReport = z.infer<typeof coverageReportSchema>;
export type SolverOutput = z.infer<typeof solverOutputSchema>;
