"""CP-SAT scheduling model (spec 6).

The whole design goal is that this NEVER returns INFEASIBLE for real input. A
manager pressing Generate on a Wednesday evening needs a roster plus an
explanation, not a solver error they cannot act on. So the hard constraint set
is kept to physics and safety only (H1-H7), and every business goal -- coverage
floors, coverage targets, כמות -- is soft with a weighted penalty.
"""

from __future__ import annotations

from ortools.sat.python import cp_model

from models import (
    COVERS,
    FREE_REST,
    HARD_REST,
    MAX_SHIFTS_PER_WEEK,
    REQUIRES_BASE,
    SEGMENTS,
    SHIFT_TYPES,
    Assignment,
    SolverInput,
    SolverOutput,
    rest_hours,
    segment_floors,
    segment_targets,
    segment_weight,
)
from verify import add_days, verify

DAYS = 7


def solve(inp: SolverInput, time_limit_s: float = 20.0, workers: int = 8) -> SolverOutput:
    model = cp_model.CpModel()
    guards = inp.guards
    w = inp.weights

    # --- variables ------------------------------------------------------------
    # x[g, d, s] == 1 iff guard g works shift s on day d.
    #
    # H1 (availability) and H2 (12h opt-in) are baked in here as constants
    # rather than as constraints: an ineligible combination is simply not a
    # variable the solver can turn on. That shrinks the search space and makes
    # those two rules unbreakable by construction.
    x: dict[tuple[int, int, str], cp_model.IntVar] = {}
    for gi, g in enumerate(guards):
        for d in range(DAYS):
            marked = set(g.availability.get(str(d), []))
            for s in SHIFT_TYPES:
                eligible = REQUIRES_BASE[s] in marked
                # Per-day opt-in: willing to do a long Monday says nothing
                # about Tuesday.
                if s == "day12" and d not in g.twelve_hour_day:
                    eligible = False
                if s == "night12" and d not in g.twelve_hour_night:
                    eligible = False
                x[gi, d, s] = (
                    model.NewBoolVar(f"x_{gi}_{d}_{s}") if eligible else model.NewConstant(0)
                )

    # --- H3: at most one shift per guard per day -------------------------------
    for gi in range(len(guards)):
        for d in range(DAYS):
            model.Add(sum(x[gi, d, s] for s in SHIFT_TYPES) <= 1)

    # --- H4: weekly ceiling (per-guard -- tightened for an explicit lower
    # request, see SolverGuard.max_shifts) --------------------------------------
    for gi, g in enumerate(guards):
        model.Add(
            sum(x[gi, d, s] for d in range(DAYS) for s in SHIFT_TYPES) <= g.max_shifts
        )

    # --- H5 hard rest + the soft 12h-rest preference ---------------------------
    rest_penalties: list[cp_model.IntVar] = []
    for gi, g in enumerate(guards):
        for d in range(DAYS - 1):
            for p in SHIFT_TYPES:
                for n in SHIFT_TYPES:
                    r = rest_hours(p, n)
                    if r < HARD_REST:
                        # Includes the four 0h cases, i.e. the No-Clopen rule.
                        model.Add(x[gi, d, p] + x[gi, d + 1, n] <= 1)
                    elif r < FREE_REST:
                        v = model.NewBoolVar(f"rest_{gi}_{d}_{p}_{n}")
                        model.Add(v >= x[gi, d, p] + x[gi, d + 1, n] - 1)
                        rest_penalties.append(v)

        # --- H7: carry-in from the previous Saturday ---------------------------
        prev = inp.carry_in.get(g.id)
        if prev:
            for n in SHIFT_TYPES:
                r = rest_hours(prev, n)
                if r < HARD_REST:
                    model.Add(x[gi, 0, n] == 0)
                elif r < FREE_REST:
                    rest_penalties.append(x[gi, 0, n])

    # --- H6 ceiling + P1/P3 soft coverage --------------------------------------
    # Gap terms are scaled by segment_weight() (S1/S4 = 2, S2/S3 = 1) so a
    # missing guard on an 8h segment costs twice what it does on a 4h segment
    # -- otherwise the objective can't tell an 8-guard-hour hole from a
    # 4-guard-hour one, and the solver picks between them arbitrarily.
    floor_gap_terms: list[cp_model.LinearExprT] = []
    target_gap_terms: list[cp_model.LinearExprT] = []
    for d in range(DAYS):
        # Per day: the raised morning target applies Mon-Fri only, so Saturday
        # and Sunday cap at 2 in the morning even when the week is set to 3.
        targets = segment_targets(inp.morning_target_slots, d)
        floors = segment_floors(inp.morning_target_slots, d)

        for seg in SEGMENTS:
            covering = [
                x[gi, d, s]
                for gi in range(len(guards))
                for s in SHIFT_TYPES
                if seg in COVERS[s]
            ]
            cov = sum(covering) if covering else 0

            # H6: never over-staff a segment.
            model.Add(cov <= targets[seg])

            fg = model.NewIntVar(0, floors[seg], f"fg_{d}_{seg}")
            model.Add(fg >= floors[seg] - cov)
            floor_gap_terms.append(segment_weight(seg) * fg)

            tg = model.NewIntVar(0, targets[seg], f"tg_{d}_{seg}")
            model.Add(tg >= targets[seg] - cov)
            target_gap_terms.append(segment_weight(seg) * tg)

    # --- P2: כמות shortfall -----------------------------------------------------
    kamut_gaps: list[cp_model.IntVar] = []
    for gi, g in enumerate(guards):
        worked = sum(x[gi, d, s] for d in range(DAYS) for s in SHIFT_TYPES)
        kg = model.NewIntVar(0, MAX_SHIFTS_PER_WEEK, f"kg_{gi}")
        model.Add(kg >= g.effective_kamut - worked)
        kamut_gaps.append(kg)

    # --- P2b: stretch bonus ------------------------------------------------------
    # A shift beyond the (already-satisfied) effective_kamut, up to the guard's
    # own stretch_target -- the requested-shift-count analogue of P4b, additive
    # on top of nothing here rather than on top of a flat term, since there is
    # no per-slot "flat" term for volume the way there is for preference.
    #
    # Mirror-image of the kamut-gap idiom above, not a copy: kamut_gaps is
    # MINIMIZED, so a bare one-sided `kg >= floor - worked` is enough -- CP-SAT
    # drives it down to its tight lower bound on its own, and a negative RHS
    # (worked comfortably clears the floor) just leaves kg resting at its own
    # domain minimum, 0 -- harmless. This term is MAXIMIZED, so naively mirroring
    # that with a bare `sb <= worked - effective_kamut` breaks the moment a guard
    # falls SHORT of effective_kamut (an ordinary, expected soft-shortfall
    # elsewhere in this same model): the RHS goes negative while sb's domain
    # floor is 0, and `0 <= negative` is unsatisfiable -- INFEASIBLE for input
    # that has every right to solve. Explicitly floor the overflow at 0 first
    # via AddMaxEquality, THEN let sb's own domain cap it at `cap` through the
    # ordinary `<=` -- both directions now degrade to sb=0 instead of failing.
    stretch_bonus: list[cp_model.IntVar] = []
    for gi, g in enumerate(guards):
        worked = sum(x[gi, d, s] for d in range(DAYS) for s in SHIFT_TYPES)
        diff = model.NewIntVar(-MAX_SHIFTS_PER_WEEK, MAX_SHIFTS_PER_WEEK, f"sdiff_{gi}")
        model.Add(diff == worked - g.effective_kamut)
        overflow = model.NewIntVar(0, MAX_SHIFTS_PER_WEEK, f"sover_{gi}")
        model.AddMaxEquality(overflow, [diff, model.NewConstant(0)])

        cap = max(0, g.stretch_target - g.effective_kamut)
        sb = model.NewIntVar(0, cap, f"sb_{gi}")
        model.Add(sb <= overflow)
        stretch_bonus.append(sb)

    # --- P4: preference weight --------------------------------------------------
    # Availability is hard, so every assignment matches a preference; this term
    # is a mild tie-breaker toward using willing guards.
    pref_terms = [x[gi, d, s] for gi in range(len(guards)) for d in range(DAYS) for s in SHIFT_TYPES]

    # --- P4b: עדיפות bonus -------------------------------------------------------
    # Added on top of pref_terms for a slot the guard marked strength 2. Kept
    # below rest8/target (spec 4.2) so it only breaks ties the other terms are
    # already indifferent to (measured trade-off: see WEIGHTS in
    # src/lib/shifts.ts).
    preferred_terms = [
        x[gi, d, s]
        for gi, g in enumerate(guards)
        for d in range(DAYS)
        for s in SHIFT_TYPES
        if REQUIRES_BASE[s] in g.preferred.get(str(d), [])
    ]

    model.Maximize(
        w.pref * sum(pref_terms)
        + w.preferred * sum(preferred_terms)
        + w.stretch * sum(stretch_bonus)
        - w.floor * sum(floor_gap_terms)
        - w.kamut * sum(kamut_gaps)
        - w.target * sum(target_gap_terms)
        - w.rest8 * sum(rest_penalties)
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit_s
    solver.parameters.num_search_workers = workers
    status = solver.Solve(model)

    status_name = solver.StatusName(status)
    assignments: list[Assignment] = []

    if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        for d in range(DAYS):
            for s in SHIFT_TYPES:
                for gi, g in enumerate(guards):
                    if solver.Value(x[gi, d, s]) == 1:
                        assignments.append(
                            Assignment(
                                day=d,
                                date=add_days(inp.week_start, d),
                                shift=s,
                                guard_id=g.id,
                            )
                        )

    # The report is produced by the referee, not by the solver describing its
    # own work -- a bug here cannot hide itself behind a flattering report.
    _violations, report, objective = verify(inp, assignments)

    return SolverOutput(
        status=status_name,
        objective_value=objective,
        assignments=assignments,
        coverage_report=report,
    )
