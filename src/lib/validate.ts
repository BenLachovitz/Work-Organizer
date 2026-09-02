import {
  MAX_SHIFTS_PER_WEEK,
  SEGMENTS,
  SHIFTS,
  classifyRest,
  restHours,
  segmentFloors,
  segmentPenaltyWeight,
  segmentTargets,
  type Segment,
  type ShiftType,
} from '@/lib/shifts';
import type {
  Assignment,
  CoverageReport,
  SolverGuard,
  SolverInput,
  SolverOutput,
} from '@/lib/solverContract';

/**
 * Independent referee for ANY solver output -- greedy mock or CP-SAT.
 *
 * Deliberately written without reference to how either engine works. It only
 * reads the input and the assignments and re-derives everything, so it can
 * catch a solver that cheats, a Python/TypeScript divergence, or a manual
 * override that broke a safety rule. Both engines are held to this one file
 * (and its Python twin) over the same fixtures.
 */

export interface Violation {
  rule: 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7';
  message: string;
  guardId?: string;
  day?: number;
}

export interface VerifyResult {
  valid: boolean;
  violations: Violation[];
  /** Recomputed from scratch -- never trusted from the solver's own output. */
  report: CoverageReport;
  objective: number;
}

const dayKey = (d: number) => String(d);

function coverageBySegment(assignments: Assignment[]): Map<string, number> {
  const cov = new Map<string, number>();
  for (const a of assignments) {
    for (const seg of SHIFTS[a.shift].covers) {
      const k = `${a.day}|${seg}`;
      cov.set(k, (cov.get(k) ?? 0) + 1);
    }
  }
  return cov;
}

export function verifySchedule(input: SolverInput, output: SolverOutput): VerifyResult {
  const violations: Violation[] = [];
  const guards = new Map<string, SolverGuard>(input.guards.map((g) => [g.id, g]));
  const assignments = output.assignments;

  // --- H1 availability, H2 12h eligibility ---------------------------------
  // A coverage-occupying placeholder (guard_id === null, §12.9/migration 52)
  // has no guard behind it -- nothing to check availability or 12h opt-in
  // against, so it's skipped entirely here rather than taught to H1/H2.
  for (const a of assignments) {
    if (a.guard_id === null) continue;
    const g = guards.get(a.guard_id);
    if (!g) {
      violations.push({
        rule: 'H1',
        message: `assignment references unknown guard ${a.guard_id}`,
        guardId: a.guard_id,
        day: a.day,
      });
      continue;
    }
    const marked = g.availability[dayKey(a.day)] ?? [];
    const def = SHIFTS[a.shift];

    if (!marked.includes(def.requiresBase)) {
      violations.push({
        rule: 'H1',
        message: `${g.id} assigned ${a.shift} on day ${a.day} without marking ${def.requiresBase}`,
        guardId: g.id,
        day: a.day,
      });
    }
    // The opt-in is per day: being willing to do a long Monday says nothing
    // about Tuesday.
    if (a.shift === 'day12' && !g.twelve_hour_day.includes(a.day)) {
      violations.push({
        rule: 'H2',
        message: `${g.id} assigned day12 on day ${a.day} without opting that day in`,
        guardId: g.id,
        day: a.day,
      });
    }
    if (a.shift === 'night12' && !g.twelve_hour_night.includes(a.day)) {
      violations.push({
        rule: 'H2',
        message: `${g.id} assigned night12 on day ${a.day} without opting that day in`,
        guardId: g.id,
        day: a.day,
      });
    }
  }

  // --- H3 one shift per day, H4 weekly ceiling -----------------------------
  // A coverage-occupying placeholder is nobody's shift -- it can't double-book
  // a guard, doesn't count toward any guard's weekly ceiling, and (via
  // `totals`, reused below for unmet_kamut and in scoreSchedule's stretch
  // bonus) doesn't count toward any guard's כמות either.
  const byGuardDay = new Map<string, ShiftType[]>();
  const totals = new Map<string, number>();
  for (const a of assignments) {
    if (a.guard_id === null) continue;
    const k = `${a.guard_id}|${a.day}`;
    const list = byGuardDay.get(k) ?? [];
    list.push(a.shift);
    byGuardDay.set(k, list);
    totals.set(a.guard_id, (totals.get(a.guard_id) ?? 0) + 1);
  }
  for (const [k, shifts] of byGuardDay) {
    if (shifts.length > 1) {
      const [guardId, day] = k.split('|');
      violations.push({
        rule: 'H3',
        message: `${guardId} has ${shifts.length} shifts on day ${day} (${shifts.join(', ')})`,
        guardId,
        day: Number(day),
      });
    }
  }
  for (const [guardId, n] of totals) {
    const ceiling = input.guards.find((g) => g.id === guardId)?.max_shifts ?? MAX_SHIFTS_PER_WEEK;
    if (n > ceiling) {
      violations.push({
        rule: 'H4',
        message: `${guardId} works ${n} shifts, ceiling is ${ceiling}`,
        guardId,
      });
    }
  }

  // --- H5 rest between consecutive days, H7 carry-in ------------------------
  const restViolations: CoverageReport['rest_violations'] = [];
  const shiftOn = new Map<string, ShiftType>();
  // Excludes coverage-occupying placeholders -- there's no guard to rest.
  for (const a of assignments) {
    if (a.guard_id === null) continue;
    shiftOn.set(`${a.guard_id}|${a.day}`, a.shift);
  }

  for (const g of input.guards) {
    // H7: previous Saturday -> this Sunday.
    const prev = input.carry_in?.[g.id] ?? null;
    const sunday = shiftOn.get(`${g.id}|0`);
    if (prev && sunday) {
      const cls = classifyRest(prev, sunday);
      if (cls === 'blocked') {
        violations.push({
          rule: 'H7',
          message: `${g.id} worked ${prev} last Saturday and ${sunday} on Sunday (${restHours(prev, sunday)}h rest)`,
          guardId: g.id,
          day: 0,
        });
      } else if (cls === 'penalised') {
        restViolations.push({
          guard_id: g.id,
          day: 0,
          from: prev,
          to: sunday,
          hours: restHours(prev, sunday),
        });
      }
    }

    for (let d = 0; d < 6; d++) {
      const a = shiftOn.get(`${g.id}|${d}`);
      const b = shiftOn.get(`${g.id}|${d + 1}`);
      if (!a || !b) continue;
      const cls = classifyRest(a, b);
      if (cls === 'blocked') {
        violations.push({
          rule: 'H5',
          message: `${g.id}: ${a} on day ${d} then ${b} on day ${d + 1} (${restHours(a, b)}h rest, minimum 8)`,
          guardId: g.id,
          day: d,
        });
      } else if (cls === 'penalised') {
        restViolations.push({
          guard_id: g.id,
          day: d,
          from: a,
          to: b,
          hours: restHours(a, b),
        });
      }
    }
  }

  // --- H6 ceiling + the coverage report -------------------------------------
  const cov = coverageBySegment(assignments);

  const floorBreaches: CoverageReport['floor_breaches'] = [];
  const targetGaps: CoverageReport['target_gaps'] = [];

  for (let d = 0; d < 7; d++) {
    // Recomputed per day: the raised morning target applies Mon-Fri only, so
    // Saturday and Sunday run 2 whatever the week is set to. Per-day
    // overrides (§1, weekly_morning_target_overrides) beat the week setting
    // for a day that has one. S2/S3/S4 have their own, independent per-day
    // overrides (weekly_segment_target_overrides).
    const targets = segmentTargets(
      input.morning_target_slots,
      d,
      input.morning_target_overrides,
      input.secondary_target_overrides,
    );
    const floors = segmentFloors(
      input.morning_target_slots,
      d,
      input.morning_target_overrides,
      input.secondary_target_overrides,
    );

    for (const seg of SEGMENTS as readonly Segment[]) {
      const assigned = cov.get(`${d}|${seg}`) ?? 0;
      if (assigned > targets[seg]) {
        violations.push({
          rule: 'H6',
          message: `day ${d} segment ${seg} has ${assigned} guards, target ceiling is ${targets[seg]}`,
          day: d,
        });
      }
      if (assigned < floors[seg]) {
        floorBreaches.push({ day: d, segment: seg, required: floors[seg], assigned });
      }
      if (assigned < targets[seg]) {
        targetGaps.push({ day: d, segment: seg, target: targets[seg], assigned });
      }
    }
  }

  const unmetKamut: CoverageReport['unmet_kamut'] = [];
  for (const g of input.guards) {
    const worked = totals.get(g.id) ?? 0;
    if (worked < g.effective_kamut) {
      unmetKamut.push({
        guard_id: g.id,
        effective_kamut: g.effective_kamut,
        assigned: worked,
      });
    }
  }

  const report: CoverageReport = {
    floor_breaches: floorBreaches,
    target_gaps: targetGaps,
    unmet_kamut: unmetKamut,
    rest_violations: restViolations,
  };

  return {
    valid: violations.length === 0,
    violations,
    report,
    objective: scoreSchedule(input, assignments, report),
  };
}

/**
 * The weighted objective from spec 4.2, recomputed independently.
 *
 * Lets us compare engines on equal terms: CP-SAT must never score below the
 * greedy mock on the same input, and if it does, one of them is wrong.
 */
export function scoreSchedule(
  input: SolverInput,
  assignments: Assignment[],
  report: CoverageReport,
): number {
  const w = input.weights;
  const guards = new Map(input.guards.map((g) => [g.id, g]));
  // segmentPenaltyWeight() weighs each gap by the segment's length (S1/S4 = 2,
  // S2/S3 = 1 -- a missing guard on an 8h segment is twice the uncovered
  // guard-hours of one on a 4h segment) plus, for S1 only, a flat
  // morning-priority bonus on top (§1.2 -- see that function's docstring).
  const floorGap = report.floor_breaches.reduce(
    (s, b) => s + segmentPenaltyWeight(b.segment, w.morning_priority) * (b.required - b.assigned),
    0,
  );
  const targetGap = report.target_gaps.reduce(
    (s, b) => s + segmentPenaltyWeight(b.segment, w.morning_priority) * (b.target - b.assigned),
    0,
  );
  const kamutGap = report.unmet_kamut.reduce((s, b) => s + (b.effective_kamut - b.assigned), 0);

  // Each assignment scores the flat pref weight, plus the preferred bonus if
  // it matches a slot the guard marked עדיפות (strength 2) that day. A
  // coverage-occupying placeholder has no guard's preference to score.
  const prefScore = assignments.reduce((s, a) => {
    if (a.guard_id === null) return s;
    const g = guards.get(a.guard_id);
    const preferred = g?.preferred[String(a.day)]?.includes(SHIFTS[a.shift].requiresBase);
    return s + w.pref + (preferred ? w.preferred : 0);
  }, 0);

  // Stretch bonus: shifts a guard worked beyond their effective_kamut, up to
  // their own stretch_target -- count-based like kamutGap, not per-assignment
  // like prefScore, since it's inherently about total volume rather than
  // which specific slot was matched. Placeholders excluded, same as above.
  const totals = new Map<string, number>();
  for (const a of assignments) {
    if (a.guard_id === null) continue;
    totals.set(a.guard_id, (totals.get(a.guard_id) ?? 0) + 1);
  }
  const stretchBonus = input.guards.reduce((s, g) => {
    const worked = totals.get(g.id) ?? 0;
    return s + Math.max(0, Math.min(worked, g.stretch_target) - g.effective_kamut);
  }, 0);

  return (
    prefScore +
    w.stretch * stretchBonus -
    w.floor * floorGap -
    w.kamut * kamutGap -
    w.target * targetGap -
    w.rest8 * report.rest_violations.length
  );
}

/** Human-readable summary for the manager, in Hebrew. */
export function summarise(report: CoverageReport): string[] {
  const out: string[] = [];
  if (report.floor_breaches.length)
    out.push(`${report.floor_breaches.length} משמרות מתחת לרצפת הבטיחות`);
  if (report.unmet_kamut.length)
    out.push(`${report.unmet_kamut.length} מאבטחים לא הגיעו ליעד הכמות`);
  if (report.target_gaps.length) out.push(`${report.target_gaps.length} מקומות פנויים מתחת ליעד`);
  if (report.rest_violations.length)
    out.push(`${report.rest_violations.length} מנוחות קצרות (8 שעות)`);
  if (!out.length) out.push('הסידור עומד בכל היעדים');
  return out;
}
