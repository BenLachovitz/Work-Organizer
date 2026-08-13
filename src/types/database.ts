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
}

export interface RosterWeek {
  week_start: string;
  morning_target_slots: 2 | 3;
  submission_deadline: string;
  status: WeekStatus;
  created_at: string;
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
  guard_id: string;
  note_before: string | null;
  note_after: string | null;
  created_at: string;
}
