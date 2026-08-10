"""GATE E (CP-SAT) -- the same golden fixtures the mock solver runs.

Both engines are judged by the same referee (verify.py / validate.ts) over the
same inputs. Anything that passes here and fails there -- or vice versa -- is a
divergence, which is exactly what this shared set exists to catch.

    solver/.venv/Scripts/python solver/tests/test_scheduler.py
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from models import SolverInput  # noqa: E402
from scheduler import solve  # noqa: E402
from verify import verify  # noqa: E402

GREEN, RED, BOLD, OFF = "\033[32m", "\033[31m", "\033[1m", "\033[0m"

passed = 0
failures: list[str] = []


def ok(label: str) -> None:
    global passed
    passed += 1
    print(f"    {GREEN}PASS{OFF}  {label}")


def bad(label: str, detail: str) -> None:
    failures.append(f"{label} -- {detail}")
    print(f"    {RED}FAIL{OFF}  {label}\n          {detail}")


def main() -> int:
    print(f"\n{BOLD}GATE E (CP-SAT) -- golden fixtures{OFF}\n")
    fixtures = sorted((HERE / "fixtures").glob("*.json"))
    results: dict[str, int] = {}

    for path in fixtures:
        print(f"{BOLD}{path.name}{OFF}")
        raw = json.loads(path.read_text(encoding="utf-8"))

        try:
            inp = SolverInput.model_validate(raw)
            ok("input parses against the contract")
        except Exception as exc:  # noqa: BLE001
            bad("input parses", str(exc)[:160])
            continue

        started = time.perf_counter()
        out = solve(inp, time_limit_s=20.0)
        ms = (time.perf_counter() - started) * 1000

        if out.status in ("OPTIMAL", "FEASIBLE"):
            ok(f"solver returned {out.status} ({len(out.assignments)} assignments, {ms:.0f}ms)")
        else:
            bad("solver status", f"{out.status} -- must never be infeasible for real input")

        violations, report, objective = verify(inp, out.assignments)
        if not violations:
            ok("no hard-rule violations")
        else:
            bad("hard rules", " | ".join(violations[:4]))

        if out.coverage_report.model_dump() == report.model_dump():
            ok("self-reported coverage matches the referee")
        else:
            bad("coverage report", "solver report disagrees with the referee")

        if out.objective_value == objective:
            ok(f"objective agrees ({objective})")
        else:
            bad("objective", f"solver {out.objective_value} vs referee {objective}")

        results[path.name] = objective

        # --- fixture-specific expectations ------------------------------------
        name = path.name
        if name.startswith("02-"):
            if not out.assignments:
                ok("empty week produces no assignments")
            else:
                bad("empty week", f"{len(out.assignments)} assignments from zero availability")

        if name.startswith("03-"):
            if len(out.assignments) <= 5:
                ok(f"5-shift ceiling respected ({len(out.assignments)})")
            else:
                bad("ceiling", f"{len(out.assignments)} shifts for one guard")

        if name.startswith("04-"):
            # Morning target 3 fixture: the raised target is Mon-Fri only, so
            # Saturday (6) and Sunday (0) must still cap at 2 -- and a working
            # day must actually reach 3, or the rule is applied nowhere.
            def s1(d: int) -> int:
                return len(
                    [a for a in out.assignments if a.day == d and a.shift in ("morning", "day12")]
                )

            weekend_over = [d for d in (0, 6) if s1(d) > 2]
            if not weekend_over:
                ok("weekend morning capped at 2 despite the week being set to 3")
            else:
                bad("weekend cap", f"days {weekend_over} exceeded 2 in the morning")

            weekdays_at_3 = [d for d in (1, 2, 3, 4, 5) if s1(d) == 3]
            if weekdays_at_3:
                ok(f"weekdays reach the raised target ({len(weekdays_at_3)} of 5 at 3)")
            else:
                bad("weekday target", "no working day reached 3 -- target 3 not applied")

        if name.startswith("05-"):
            by_guard: dict[str, dict[int, str]] = {}
            for a in out.assignments:
                by_guard.setdefault(a.guard_id, {})[a.day] = a.shift
            clopens = sum(
                1
                for days in by_guard.values()
                for d in range(6)
                if days.get(d) in ("night", "night12") and days.get(d + 1) in ("morning", "day12")
            )
            if clopens == 0:
                ok("no clopen even when only night+morning were offered")
            else:
                bad("clopen trap", f"{clopens} night -> next-morning pairs")

        if name.startswith("06-"):
            twelve = [a for a in out.assignments if a.shift in ("day12", "night12")]
            if twelve:
                ok(f"12h shifts used where opted in ({len(twelve)})")
            else:
                bad("12h", "no extended shifts despite opt-ins")

        if name.startswith("08-"):
            # Available all week, but only Monday and Tuesday were opted in.
            # A week-level reading of the flag would place 12h shifts elsewhere.
            extended = [a for a in out.assignments if a.shift in ("day12", "night12")]
            strays = [a for a in extended if a.day not in (1, 2)]
            if not strays:
                ok(f"12h shifts confined to the opted-in days ({len(extended)} on Mon/Tue)")
            else:
                bad("per-day opt-in", f"{len(strays)} extended shifts outside Mon/Tue")
            if extended:
                ok("12h shifts still used on the days that were opted in")
            else:
                bad("per-day opt-in", "no 12h shift scheduled at all -- opt-in ignored")

        if name.startswith("07-"):
            sunday = {a.guard_id: a.shift for a in out.assignments if a.day == 0}
            offenders = [g for g in ("g1", "g2") if sunday.get(g) in ("morning", "day12")]
            if not offenders:
                ok("carry-in honoured: Saturday-night guards get no Sunday morning")
            else:
                bad("carry-in", f"{offenders} scheduled Sunday morning after a night shift")

        if name.startswith("09-"):
            # Capacity is exactly one guard-shift short of full day-0 coverage,
            # and (verified by hand) leaving an 8h segment (S1/S4) short scores
            # identically to leaving a 4h one (S2/S3) under a flat per-slot
            # count -- segment_weight() is what breaks that tie correctly.
            day0_gap = next((g.segment for g in report.target_gaps if g.day == 0), None)
            if day0_gap in ("S2", "S3"):
                ok(f"the unavoidable gap lands on the cheaper 4h segment ({day0_gap})")
            else:
                bad("segment weighting", f"gap landed on {day0_gap!r}, expected S2 or S3")

        if name.startswith("10-"):
            # morning and night are otherwise perfectly symmetric (each closes
            # exactly one segment's floor+target by the same amount, same
            # kamut contribution, no rest neighbours) -- only the עדיפות mark
            # on night breaks the tie. If this ever picks morning, the
            # preferred bonus isn't reaching the objective.
            solo = next((a.shift for a in out.assignments if a.guard_id == "solo"), None)
            if solo == "night":
                ok("preferred slot (night) wins an otherwise perfect coverage tie")
            else:
                bad("preference tie-break", f"solo assigned {solo!r}, expected 'night'")

        if name.startswith("11-"):
            assigned_ids = {a.guard_id for a in out.assignments}

            # Day 1: decoy_s1_day1 always fills the floor (guaranteed, not the
            # thing under test) -- the CONTESTED slot is the remaining
            # target-2 spot between wants_more and at_kamut, same coverage
            # value either way, only the stretch bonus differs.
            if "wants_more" in assigned_ids and "at_kamut" not in assigned_ids:
                ok("stretch bonus wins a genuine tie for the extra slot (wants_more over at_kamut)")
            else:
                bad(
                    "stretch tie-break",
                    f"wants_more assigned={'wants_more' in assigned_ids}, "
                    f"at_kamut assigned={'at_kamut' in assigned_ids}",
                )

            # Day 4: would_cost_rest could extend from 1 to 2 shifts, but only
            # via an 8h-penalised afternoon(day3)->morning(day4) transition;
            # decoy_no_rest contests the same last slot for free. stretch(1)
            # must not outweigh rest8(5).
            worked = [a for a in out.assignments if a.guard_id == "would_cost_rest"]
            if len(worked) == 1 and worked[0].day == 3:
                ok("stretch bonus does not outweigh an 8h-rest penalty (would_cost_rest stays at 1 shift)")
            else:
                bad(
                    "stretch vs rest8",
                    f"would_cost_rest has {len(worked)} shift(s) on day(s) {[a.day for a in worked]}",
                )

            if "decoy_no_rest" in assigned_ids:
                ok("the rest-free alternative fills the slot instead")
            else:
                bad("stretch vs rest8 alternative", "decoy_no_rest was not assigned")

        if name.startswith("12-"):
            # capped_guard explicitly requested fewer shifts than configured
            # (max_shifts: 1) and is the ONLY guard available on day 0 or day
            # 1 -- assigning him both would trivially clear two S1 floor
            # breaches (each worth 1000), the strongest possible incentive to
            # exceed the cap. The hard per-guard H4 ceiling must win anyway:
            # this is exactly the bug a real guard hit in production
            # (requested 1, was assigned 2).
            worked = [a for a in out.assignments if a.guard_id == "capped_guard"]
            if len(worked) <= 1:
                ok(f"guard-requested ceiling holds even when coverage would reward breaking it ({len(worked)} shift(s))")
            else:
                bad("guard shift ceiling", f"capped_guard assigned {len(worked)} shifts, requested max was 1")

            s1_breaches = [b for b in report.floor_breaches if b.day <= 1 and b.segment == "S1"]
            if len(s1_breaches) == 1:
                ok("the day the ceiling blocked him shows up as a genuine floor breach, not a silently absorbed cost")
            else:
                bad("guard shift ceiling", f"expected exactly 1 S1 floor breach across days 0-1, got {len(s1_breaches)}")

        if name.startswith("13-"):
            # sixth_shift_guard is configured at 5 (the ordinary ceiling) and
            # asked for a 6th; they are also the ONLY guard available for S1
            # on days 0-5, so all 6 floors can only close through them --
            # proves max_shifts=6 actually lets the solver reach 6 (the
            # CP-SAT domain-bound class of bug a naive per-guard H4 change
            # could reintroduce).
            sixth = [a for a in out.assignments if a.guard_id == "sixth_shift_guard"]
            if len(sixth) == 6:
                ok("a guard configured at 5 who explicitly asked for a 6th shift can actually reach it")
            else:
                bad("sixth shift grant", f"sixth_shift_guard assigned {len(sixth)} shifts, expected 6")

            # capped_at_five requested 5 (not 6) and is under IDENTICAL
            # temptation (sole coverage for S4 on the same 6 days) -- not
            # being configured at 5 means max_shifts stayed 5, so one night
            # floor must go unfilled rather than let them sneak past the
            # ordinary ceiling too.
            capped = [a for a in out.assignments if a.guard_id == "capped_at_five"]
            if len(capped) <= 5:
                ok(f"the 6th-shift allowance stays exclusive to a guard configured at 5 (capped_at_five: {len(capped)} shift(s))")
            else:
                bad("sixth shift exclusivity", f"capped_at_five assigned {len(capped)} shifts, ceiling was 5")

            s4_breaches = [b for b in report.floor_breaches if b.day <= 5 and b.segment == "S4"]
            if len(s4_breaches) == 1:
                ok("the un-eligible guard hitting their real ceiling shows up as a genuine floor breach")
            else:
                bad("sixth shift exclusivity", f"expected exactly 1 S4 floor breach across days 0-5, got {len(s4_breaches)}")

        if name.startswith("14-"):
            # 3 guards, all morning-available Mon-Fri, kamut 5 each (maximum
            # pressure to work every marked day). Baseline target is 2;
            # Thu/Fri (days 4,5) are overridden to 3. Mon-Wed must never
            # exceed 2 (H6 -- the override must not leak outside its days),
            # and Thu/Fri must actually reach 3 (the override must apply).
            def s1_count(d: int) -> int:
                return len([a for a in out.assignments if a.day == d and a.shift == "morning"])

            over_cap = [d for d in (1, 2, 3) if s1_count(d) > 2]
            if not over_cap:
                ok("non-overridden weekdays (Mon-Wed) stay capped at the week's baseline target of 2")
            else:
                bad("per-day override leak", f"days {over_cap} exceeded 2 despite no override")

            raised = [d for d in (4, 5) if s1_count(d) == 3]
            if len(raised) == 2:
                ok("both overridden days (Thu, Fri) actually reach the raised target of 3")
            else:
                bad("per-day override", f"only days {raised} of [4, 5] reached 3")

        if name.startswith("15-"):
            # anchor_s1/anchor_s4 each guarantee one segment's floor; flexible
            # could close either segment's remaining target gap, and both
            # segments are otherwise perfectly symmetric (same length weight,
            # same kamut contribution, no rest neighbours) -- only the
            # morning_priority bonus (set to 1 in this fixture's weights)
            # should break the tie toward morning.
            flexible = next((a.shift for a in out.assignments if a.guard_id == "flexible"), None)
            if flexible == "morning":
                ok("morning_priority bonus wins an otherwise perfect S1-vs-S4 coverage tie")
            else:
                bad("morning-priority tie-break", f"flexible assigned {flexible!r}, expected 'morning'")

        print()

    # CP-SAT is optimal; the greedy mock is not. Recording the scores lets
    # compare-engines.mjs assert CP-SAT >= mock on every fixture.
    (HERE / ".cpsat-scores.json").write_text(json.dumps(results, indent=2), encoding="utf-8")

    print(f"{BOLD}Result:{OFF} {GREEN}{passed} passed{OFF}, "
          f"{(RED + str(len(failures)) + ' failed' + OFF) if failures else '0 failed'}")
    if failures:
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"\n{GREEN}GATE E (CP-SAT) PASSED{OFF}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
