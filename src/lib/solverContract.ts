import { z } from 'zod';
import { BASE_SHIFTS, SHIFT_TYPES, SEGMENTS, WEIGHTS } from '@/lib/shifts';

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
});

export const solverGuardSchema = z.object({
  id: z.string().min(1),
  display_name: z.string().optional(),
  /** Already lowered by min(configured, available_days, 5) before it gets here. */
  effective_kamut: z.number().int().min(0).max(5),
  can_work_12h_day: z.boolean(),
  can_work_12h_night: z.boolean(),
  /** Day index "0".."6" (Sunday-first) -> the base shifts they marked. */
  availability: z.record(z.string(), z.array(baseShiftSchema)),
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
