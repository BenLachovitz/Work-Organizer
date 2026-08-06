"""FastAPI wrapper around the CP-SAT scheduler.

Supabase Edge Functions run Deno and cannot execute Python or OR-Tools, so the
solver lives here as a small service (Render / Railway free tier).

It is NOT called from the browser. The flow is:

    browser -> Supabase Edge Function (verifies the caller is a manager,
                                       holds SOLVER_SECRET) -> this service

so the shared secret never reaches a phone.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, Header, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

from models import SolverInput, SolverOutput  # noqa: E402
from scheduler import solve  # noqa: E402
from verify import verify  # noqa: E402

SOLVER_SECRET = os.environ.get("SOLVER_SECRET", "")
TIME_LIMIT = float(os.environ.get("SOLVER_TIME_LIMIT", "20"))

app = FastAPI(title="guard-scheduler-solver", version="1.0.0")

# The Edge Function calls server-to-server, so CORS is not needed for the real
# path. Kept permissive only for local development against the Vite dev server.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, object]:
    """Also used to wake the instance: Render's free tier sleeps after 15
    minutes idle and cold-starts in roughly 50 seconds."""
    return {"ok": True, "service": "guard-scheduler-solver"}


@app.post("/solve", response_model=SolverOutput)
def solve_endpoint(
    payload: SolverInput,
    authorization: str | None = Header(default=None),
) -> SolverOutput:
    # Constant-ish comparison; the secret is a fixed-length token so a timing
    # side channel here is not meaningful, but fail closed if it is unset.
    if not SOLVER_SECRET:
        raise HTTPException(status_code=500, detail="SOLVER_SECRET not configured")
    if authorization != f"Bearer {SOLVER_SECRET}":
        raise HTTPException(status_code=401, detail="unauthorized")

    if not payload.guards:
        # Not an error: a week where nobody submitted is a real state, and the
        # manager should get an empty roster plus a full breach report.
        _v, report, objective = verify(payload, [])
        return SolverOutput(
            status="EMPTY", objective_value=objective, assignments=[], coverage_report=report
        )

    started = time.perf_counter()
    result = solve(payload, time_limit_s=TIME_LIMIT)
    elapsed = (time.perf_counter() - started) * 1000

    # Refuse to return a schedule that breaks a hard rule. Better a visible
    # failure than a roster that quietly puts someone on a clopen.
    violations, _report, _objective = verify(payload, result.assignments)
    if violations:
        raise HTTPException(
            status_code=500,
            detail={"error": "solver produced an invalid schedule", "violations": violations[:10]},
        )

    print(
        f"solved week={payload.week_start} guards={len(payload.guards)} "
        f"status={result.status} assignments={len(result.assignments)} "
        f"objective={result.objective_value} in {elapsed:.0f}ms",
        flush=True,
    )
    return result
