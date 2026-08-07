"""READ-ONLY CP-SAT preview of a dumped solver input.

Prints the roster in the same shape as the TypeScript preview so the two
engines can be compared line by line on identical data.

    node --experimental-strip-types supabase/tests/preview-week.mjs --dump solver/tests/realweek.json
    solver/.venv/Scripts/python solver/tests/preview_cpsat.py solver/tests/realweek.json
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from models import SolverInput  # noqa: E402
from scheduler import solve  # noqa: E402
from verify import verify  # noqa: E402

HE = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"]
WIDTH = 26


def main() -> int:
    path = Path(sys.argv[1] if len(sys.argv) > 1 else HERE / "realweek.json")
    inp = SolverInput.model_validate(json.loads(path.read_text(encoding="utf-8")))
    out = solve(inp, time_limit_s=30)
    violations, report, objective = verify(inp, out.assignments)

    names = {g.id: (g.display_name or g.id[:6]) for g in inp.guards}

    def cell(day: int, block: str) -> str:
        on = [a for a in out.assignments if a.day == day]
        if block == "m":
            rows = [
                names[a.guard_id] + (" עד18:45" if a.shift == "day12" else "")
                for a in on
                if a.shift in ("morning", "day12")
            ]
        elif block == "n":
            rows = [
                names[a.guard_id] + (" מ18:45" if a.shift == "night12" else "")
                for a in on
                if a.shift in ("night", "night12")
            ]
        else:
            full = [a for a in on if a.shift == "afternoon"]
            early = [a for a in on if a.shift == "day12"]
            late = [a for a in on if a.shift == "night12"]
            rows = [names[a.guard_id] for a in full]
            for i in range(max(len(early), len(late))):
                e = names[early[i].guard_id] if i < len(early) else "(ריק)"
                l = names[late[i].guard_id] if i < len(late) else "(ריק)"
                rows.append(f"{e}/{l}")
        return ", ".join(rows) or "—"

    print(f"\nCP-SAT -- {out.status}, {len(out.assignments)} assignments, objective {objective}\n")
    print("          " + "".join(h.ljust(WIDTH) for h in HE))
    for key, label in (("m", "בוקר     "), ("a", "צהריים   "), ("n", "לילה     ")):
        print(label + " " + "".join(cell(d, key).ljust(WIDTH) for d in range(7)))

    worked: dict[str, int] = {}
    for a in out.assignments:
        worked[a.guard_id] = worked.get(a.guard_id, 0) + 1

    print("\nshifts per guard:")
    for g in inp.guards:
        n = worked.get(g.id, 0)
        flag = "  <- short" if n < g.effective_kamut else ""
        print(f"  {names[g.id]:<10} {n} / {g.effective_kamut}{flag}")

    print(f"\nhard violations : {len(violations)}")
    print(
        f"floor breaches  : {len(report.floor_breaches)}  "
        + ", ".join(f"{HE[b.day]}/{b.segment}" for b in report.floor_breaches)
    )
    print(f"target gaps     : {len(report.target_gaps)}")
    print(f"unmet kamut     : {len(report.unmet_kamut)}")
    print(f"8h rests        : {len(report.rest_violations)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
