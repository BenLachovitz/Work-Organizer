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
