/**
 * Database types, hand-written to match supabase/migrations/*.
 * Replace with the generated file once the cloud project exists:
 *   supabase gen types typescript --project-id <id> > src/types/database.ts
 */

import type { BaseShift, ShiftType } from '@/lib/shifts';

export type UserRole = 'admin' | 'manager' | 'guard';
export type WeekStatus = 'open' | 'locked' | 'generated' | 'published';

export interface Profile {
  id: string;
  employee_code: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  /** Baseline weekly כמות. Seeds weekly_guard_targets for a week that has no row yet. */
  default_kamut: number;
  /** True for a seeded mock guard used to sanity-test the scheduler. Source
   *  of truth for the admin real/test view-mode toggle (src/lib/viewMode.ts). */
  is_demo: boolean;
  /** E.164, optional. Powers the "currently on shift" card's tap-to-call/
   *  tap-to-WhatsApp links -- NULL means no icons show for this guard. */
  phone_number: string | null;
}

export interface RosterWeek {
  week_start: string;
  morning_target_slots: 2 | 3;
  submission_deadline: string;
  status: WeekStatus;
  created_at: string;
  /** Display-only. day12/night12 always count as 12h everywhere it matters;
   *  this only shortens the handover-boundary text by one hour when set to
   *  11. See doubleShiftSuffix()/doubleShiftLabel() in src/lib/shifts.ts. */
  double_shift_display_hours: 11 | 12;
  /** How many guards (2 or 3) cover this week's Yom Kippur block, if this
   *  week has one -- migration 54. NULL on every ordinary week. See
   *  src/lib/holidays.ts and useKippurGuards() in src/hooks/useManager.ts. */
  kippur_guard_count: 2 | 3 | null;
}

export interface WeeklySubmission {
  id: string;
  guard_id: string;
  week_start: string;
  submitted_at: string;
  updated_at: string;
  /** Free-text context from the guard, e.g. "prefers night shifts". Never read by the solver. */
  notes: string | null;
  /** Guard-stated preferred shift count for the week, NULL = no explicit
   *  request. See effectiveKamut()/stretchTarget() in src/lib/shifts.ts. */
  requested_shifts: number | null;
}

export interface WishPreference {
  id: string;
  guard_id: string;
  week_start: string;
  target_date: string;
  shift: BaseShift;
  /** Extend this specific shift to 12h. morning -> day12, night -> night12. */
  allows_12h: boolean;
  strength: 1 | 2;
  created_at: string;
}

export interface WeeklyGuardTarget {
  id: string;
  week_start: string;
  guard_id: string;
  configured_kamut: number;
  effective_kamut: number | null;
}

export interface CoverageReport {
  floor_breaches: { day: number; segment: string; required: number; assigned: number }[];
  target_gaps: { day: number; segment: string; target: number; assigned: number }[];
  unmet_kamut: { guard_id: string; effective_kamut: number; assigned: number }[];
  rest_violations: {
    guard_id: string;
    day: number;
    from: ShiftType;
    to: ShiftType;
    hours: number;
  }[];
  kamut_overrides: {
    guard_id: string;
    configured: number;
    available_days: number;
    effective: number;
  }[];
}

export interface ScheduleRun {
  id: string;
  week_start: string;
  version: number;
  solver_status: string;
  objective_value: number | null;
  coverage_report: CoverageReport;
  is_published: boolean;
  generated_by: string | null;
  generated_at: string;
  published_at: string | null;
}

export interface ScheduleAssignment {
  id: string;
  run_id: string;
  target_date: string;
  shift: ShiftType;
  /** NULL means this row is a placeholder -- a note-only cell annotation with no real guard behind it (§12.9). */
  guard_id: string | null;
  note_before: string | null;
  note_after: string | null;
  /** Placeholder-only: TRUE counts this guard-less row toward coverage like a real assignment. Always FALSE when guard_id is set. */
  occupies_slot: boolean;
  created_at: string;
}

export type WorkLogSource = 'roster' | 'edited' | 'manual';

/** A guard's personal log of hours actually worked -- the estimated-salary
 *  feature. Independent of ScheduleAssignment; source_assignment_id is only
 *  used to avoid re-seeding a row the guard already has. */
export interface WorkLogEntry {
  id: string;
  guard_id: string;
  target_date: string;
  shift: ShiftType | null;
  source: WorkLogSource;
  source_assignment_id: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  actual_start: string;
  actual_end: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export type AbsenceType = 'sick' | 'vacation';

/** A guard's self-reported sick/vacation day -- no balance or ledger, see
 *  migration 64. Not worked time; never read by computePayroll's overtime
 *  engine, only by the separate sick/vacation pay calculation. */
export interface WorkLogAbsence {
  id: string;
  guard_id: string;
  target_date: string;
  type: AbsenceType;
  note: string | null;
  created_at: string;
  updated_at: string;
}
