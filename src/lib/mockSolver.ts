import {
  MAX_SHIFTS_PER_WEEK,
  SHIFTS,
  SHIFT_TYPES,
  classifyRest,
  segmentFloors,
  segmentTargets,
  segmentWeight,
  type Segment,
  type ShiftType,
} from '@/lib/shifts';
import type { Assignment, SolverInput, SolverOutput } from '@/lib/solverContract';
import { verifySchedule } from '@/lib/validate';
import { addDays } from '@/lib/dates';

/**
 * Greedy stand-in for CP-SAT.
 *
 * Not optimal and not trying to be -- its job is to unblock the UI and to give
 * the real solver a floor to beat. It hill-climbs the same weighted objective
 * (spec 4.2) one assignment at a time, taking the highest-scoring legal move
 * until nothing improves the score.
 *
 * Every candidate is checked against the hard rules BEFORE being taken, so its
 * output is always legal even when it is not optimal. That is what makes it
 * safe to fall back to when the solver service is unreachable.
 */
export function mockSolve(input: SolverInput): SolverOutput {
  // Per day, because the raised morning target applies Mon-Fri only.
  const targetsOn = (day: number) => segmentTargets(input.morning_target_slots, day);
  const floorsOn = (day: number) => segmentFloors(input.morning_target_slots, day);
  const w = input.weights;

  const assignments: Assignment[] = [];
  const shiftOn = new Map<string, ShiftType>(); // `${guardId}|${day}` -> shift
  const worked = new Map<string, number>();
  const cov = new Map<string, number>(); // `${day}|${segment}` -> count

  const covOf = (day: number, seg: Segment) => cov.get(`${day}|${seg}`) ?? 0;
  const workedOf = (id: string) => worked.get(id) ?? 0;

  /** Hard rules H1-H7. A move is only considered if this returns true. */
  function isLegal(guardId: string, day: number, shift: ShiftType): boolean {
    const g = input.guards.find((x) => x.id === guardId);
    if (!g) return false;

    // H3: one shift per day
    if (shiftOn.has(`${guardId}|${day}`)) return false;

    // H4: weekly ceiling
    if (workedOf(guardId) >= MAX_SHIFTS_PER_WEEK) return false;

    // H1 + H2: availability and 12h opt-in
    const marked = g.availability[String(day)] ?? [];
    const def = SHIFTS[shift];
    if (!marked.includes(def.requiresBase)) return false;
    if (shift === 'day12' && !g.twelve_hour_day.includes(day)) return false;
    if (shift === 'night12' && !g.twelve_hour_night.includes(day)) return false;

    // H6: never exceed the target ceiling
    for (const seg of def.covers) {
      if (covOf(day, seg) + 1 > targetsOn(day)[seg]) return false;
    }

    // H5: rest against the neighbouring days
    const before = day > 0 ? shiftOn.get(`${guardId}|${day - 1}`) : undefined;
    if (before && classifyRest(before, shift) === 'blocked') return false;
    const after = day < 6 ? shiftOn.get(`${guardId}|${day + 1}`) : undefined;
    if (after && classifyRest(shift, after) === 'blocked') return false;

    // H7: carry-in from the previous Saturday
    if (day === 0) {
      const prev = input.carry_in?.[guardId] ?? null;
      if (prev && classifyRest(prev, shift) === 'blocked') return false;
    }
    return true;
  }

  /** Marginal objective gain of taking this move. */
  function gain(guardId: string, day: number, shift: ShiftType): number {
    let score = w.pref;

    const g = input.guards.find((x) => x.id === guardId)!;
    if (g.preferred[String(day)]?.includes(SHIFTS[shift].requiresBase)) {
      score += w.preferred;
    }

    for (const seg of SHIFTS[shift].covers) {
      const c = covOf(day, seg);
      // Below the floor is also below the target, so both penalties shrink --
      // which is exactly why floor-filling dominates everything else. Scaled
      // by segmentWeight() so closing an 8h segment's gap (S1/S4) is worth
      // more than closing a 4h segment's gap (S2/S3) -- otherwise the solver
      // can't tell an 8-guard-hour hole from a 4-guard-hour one.
      if (c < floorsOn(day)[seg]) score += w.floor * segmentWeight(seg);
      if (c < targetsOn(day)[seg]) score += w.target * segmentWeight(seg);
    }

    if (workedOf(guardId) < g.effective_kamut) score += w.kamut;
    // Stretch bonus: a shift beyond the (already-satisfied) effective כמות,
    // up to the guard's own stretch_target -- the requested-shift-count
    // analogue of the עדיפות bonus below, additive on top of nothing rather
    // than on top of w.pref, since there is no "flat" term for volume the
    // way there is for a specific slot.
    if (workedOf(guardId) >= g.effective_kamut && workedOf(guardId) < g.stretch_target) {
      score += w.stretch;
    }

    const before = day > 0 ? shiftOn.get(`${guardId}|${day - 1}`) : undefined;
    if (before && classifyRest(before, shift) === 'penalised') score -= w.rest8;
    const after = day < 6 ? shiftOn.get(`${guardId}|${day + 1}`) : undefined;
    if (after && classifyRest(shift, after) === 'penalised') score -= w.rest8;
    if (day === 0) {
      const prev = input.carry_in?.[guardId] ?? null;
      if (prev && classifyRest(prev, shift) === 'penalised') score -= w.rest8;
    }
    return score;
  }

  // Hill-climb until no move improves the score.
  for (let iteration = 0; iteration < 7 * SHIFT_TYPES.length * input.guards.length; iteration++) {
    let best: { guardId: string; day: number; shift: ShiftType; gain: number } | null = null;

    for (const g of input.guards) {
      for (let day = 0; day < 7; day++) {
        for (const shift of SHIFT_TYPES) {
          if (!isLegal(g.id, day, shift)) continue;
          const value = gain(g.id, day, shift);
          if (value > 0 && (!best || value > best.gain)) {
            best = { guardId: g.id, day, shift, gain: value };
          }
        }
      }
    }

    if (!best) break;

    assignments.push({
      day: best.day,
      date: addDays(input.week_start, best.day),
      shift: best.shift,
      guard_id: best.guardId,
    });
    shiftOn.set(`${best.guardId}|${best.day}`, best.shift);
    worked.set(best.guardId, workedOf(best.guardId) + 1);
    for (const seg of SHIFTS[best.shift].covers) {
      const k = `${best.day}|${seg}`;
      cov.set(k, (cov.get(k) ?? 0) + 1);
    }
  }

  assignments.sort((a, b) => a.day - b.day || a.shift.localeCompare(b.shift));

  // The report is produced by the verifier, not by the solver describing its
  // own work -- so a bug here cannot hide itself in a flattering report.
  const verdict = verifySchedule(input, {
    status: 'MOCK',
    objective_value: 0,
    assignments,
    coverage_report: emptyReport(),
  });

  return {
    status: 'MOCK',
    objective_value: verdict.objective,
    assignments,
    coverage_report: verdict.report,
  };
}

function emptyReport() {
  return { floor_breaches: [], target_gaps: [], unmet_kamut: [], rest_violations: [] };
}
