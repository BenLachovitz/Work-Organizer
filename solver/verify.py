"""Independent referee -- the Python twin of src/lib/validate.ts.

Written without reference to how the solver works: it reads only the input and
the assignments and re-derives everything. That is what lets it catch a solver
that cheats, a divergence between the two engines, or a manual override that
broke a safety rule.
"""

from __future__ import annotations

from datetime import date, timedelta

from models import (
    COVERS,
    FREE_REST,
    HARD_REST,
    MAX_SHIFTS_PER_WEEK,
    REQUIRES_BASE,
    SEGMENTS,
    Assignment,
    CoverageReport,
    FloorBreach,
    RestViolation,
    SolverInput,
    TargetGap,
    UnmetKamut,
    rest_hours,
    segment_floors,
    segment_targets,
    segment_weight,
)


def add_days(iso: str, n: int) -> str:
    y, m, d = (int(x) for x in iso.split("-"))
    return (date(y, m, d) + timedelta(days=n)).isoformat()


def classify_rest(prev: str, nxt: str) -> str:
    r = rest_hours(prev, nxt)
    if r < HARD_REST:
        return "blocked"
    if r < FREE_REST:
        return "penalised"
    return "free"


def verify(inp: SolverInput, assignments: list[Assignment]) -> tuple[list[str], CoverageReport, int]:
    """Returns (violations, recomputed report, recomputed objective)."""
    violations: list[str] = []
    guards = {g.id: g for g in inp.guards}

    # --- H1 availability, H2 12h eligibility ---------------------------------
    for a in assignments:
        g = guards.get(a.guard_id)
        if g is None:
            violations.append(f"H1: unknown guard {a.guard_id}")
            continue
        marked = g.availability.get(str(a.day), [])
        if REQUIRES_BASE[a.shift] not in marked:
            violations.append(
                f"H1: {g.id} assigned {a.shift} on day {a.day} without marking {REQUIRES_BASE[a.shift]}"
            )
        # The opt-in is per day: a long Monday says nothing about Tuesday.
        if a.shift == "day12" and a.day not in g.twelve_hour_day:
            violations.append(f"H2: {g.id} assigned day12 on day {a.day} without opting it in")
        if a.shift == "night12" and a.day not in g.twelve_hour_night:
            violations.append(f"H2: {g.id} assigned night12 on day {a.day} without opting it in")

    # --- H3 one shift per day, H4 weekly ceiling -----------------------------
    by_guard_day: dict[tuple[str, int], list[str]] = {}
    totals: dict[str, int] = {}
    for a in assignments:
        by_guard_day.setdefault((a.guard_id, a.day), []).append(a.shift)
        totals[a.guard_id] = totals.get(a.guard_id, 0) + 1

    for (gid, day), shifts in by_guard_day.items():
        if len(shifts) > 1:
            violations.append(f"H3: {gid} has {len(shifts)} shifts on day {day}")
    for gid, n in totals.items():
        ceiling = guards[gid].max_shifts if gid in guards else MAX_SHIFTS_PER_WEEK
        if n > ceiling:
            violations.append(f"H4: {gid} works {n} shifts, ceiling {ceiling}")

    # --- H5 rest, H7 carry-in -------------------------------------------------
    rest_violations: list[RestViolation] = []
    shift_on = {(a.guard_id, a.day): a.shift for a in assignments}

    for g in inp.guards:
        prev = inp.carry_in.get(g.id)
        sunday = shift_on.get((g.id, 0))
        if prev and sunday:
            cls = classify_rest(prev, sunday)
            if cls == "blocked":
                violations.append(
                    f"H7: {g.id} worked {prev} last Saturday then {sunday} on Sunday "
                    f"({rest_hours(prev, sunday)}h rest)"
                )
            elif cls == "penalised":
                rest_violations.append(
                    RestViolation(guard_id=g.id, day=0, to=sunday, hours=rest_hours(prev, sunday), **{"from": prev})
                )

        for d in range(6):
            a = shift_on.get((g.id, d))
            b = shift_on.get((g.id, d + 1))
            if not a or not b:
                continue
            cls = classify_rest(a, b)
            if cls == "blocked":
                violations.append(
                    f"H5: {g.id} {a} on day {d} then {b} on day {d + 1} "
                    f"({rest_hours(a, b)}h rest, minimum {HARD_REST})"
                )
            elif cls == "penalised":
                rest_violations.append(
                    RestViolation(guard_id=g.id, day=d, to=b, hours=rest_hours(a, b), **{"from": a})
                )

    # --- H6 ceiling + coverage report -----------------------------------------
    cov: dict[tuple[int, str], int] = {}
    for a in assignments:
        for seg in COVERS[a.shift]:
            cov[(a.day, seg)] = cov.get((a.day, seg), 0) + 1

    floor_breaches: list[FloorBreach] = []
    target_gaps: list[TargetGap] = []
    for d in range(7):
        # Recomputed per day: the raised morning target applies Mon-Fri only.
        targets = segment_targets(inp.morning_target_slots, d)
        floors = segment_floors(inp.morning_target_slots, d)
        for seg in SEGMENTS:
            assigned = cov.get((d, seg), 0)
            if assigned > targets[seg]:
                violations.append(
                    f"H6: day {d} segment {seg} has {assigned}, ceiling {targets[seg]}"
                )
            if assigned < floors[seg]:
                floor_breaches.append(
                    FloorBreach(day=d, segment=seg, required=floors[seg], assigned=assigned)
                )
            if assigned < targets[seg]:
                target_gaps.append(
                    TargetGap(day=d, segment=seg, target=targets[seg], assigned=assigned)
                )

    unmet = [
        UnmetKamut(guard_id=g.id, effective_kamut=g.effective_kamut, assigned=totals.get(g.id, 0))
        for g in inp.guards
        if totals.get(g.id, 0) < g.effective_kamut
    ]

    report = CoverageReport(
        floor_breaches=floor_breaches,
        target_gaps=target_gaps,
        unmet_kamut=unmet,
        rest_violations=rest_violations,
    )
    return violations, report, score(inp, assignments, report)


def score(inp: SolverInput, assignments: list[Assignment], report: CoverageReport) -> int:
    """The weighted objective from spec 4.2, recomputed independently."""
    w = inp.weights
    guards = {g.id: g for g in inp.guards}
    # segment_weight() scales each gap by the segment's length (S1/S4 = 2,
    # S2/S3 = 1) -- see the docstring on that function in models.py.
    floor_gap = sum(segment_weight(b.segment) * (b.required - b.assigned) for b in report.floor_breaches)
    target_gap = sum(segment_weight(b.segment) * (b.target - b.assigned) for b in report.target_gaps)
    kamut_gap = sum(b.effective_kamut - b.assigned for b in report.unmet_kamut)

    # Each assignment scores the flat pref weight, plus the preferred bonus if
    # it matches a slot the guard marked עדיפות (strength 2) that day.
    pref_score = 0
    for a in assignments:
        pref_score += w.pref
        g = guards.get(a.guard_id)
        if g and REQUIRES_BASE[a.shift] in g.preferred.get(str(a.day), []):
            pref_score += w.preferred

    # Stretch bonus: shifts worked beyond effective_kamut, up to stretch_target
    # -- count-based like kamut_gap, not per-assignment like pref_score, since
    # it's inherently about total volume rather than which slot was matched.
    totals: dict[str, int] = {}
    for a in assignments:
        totals[a.guard_id] = totals.get(a.guard_id, 0) + 1
    stretch_bonus = sum(
        max(0, min(totals.get(g.id, 0), g.stretch_target) - g.effective_kamut) for g in inp.guards
    )

    return (
        pref_score
        + w.stretch * stretch_bonus
        - w.floor * floor_gap
        - w.kamut * kamut_gap
        - w.target * target_gap
        - w.rest8 * len(report.rest_violations)
    )
