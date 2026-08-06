"""Wire contract, mirroring src/lib/solverContract.ts.

Neither side is generated from the other. What keeps them honest is
tests/fixtures/*.json: both engines parse every fixture and their output is
judged by the same rules (verify.py here, src/lib/validate.ts there).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

BaseShift = Literal["morning", "afternoon", "night"]
ShiftType = Literal["morning", "afternoon", "night", "day12", "night12"]
Segment = Literal["S1", "S2", "S3", "S4"]

SHIFT_TYPES: list[ShiftType] = ["morning", "afternoon", "night", "day12", "night12"]
SEGMENTS: list[Segment] = ["S1", "S2", "S3", "S4"]

# Which segments each shift covers (spec 2.3). The 8h grid and the 12h grid are
# two different partitions of the same 24 hours; both tile it exactly.
COVERS: dict[ShiftType, list[Segment]] = {
    "morning": ["S1"],
    "afternoon": ["S2", "S3"],
    "night": ["S4"],
    "day12": ["S1", "S2"],
    "night12": ["S3", "S4"],
}

# The base availability a guard must have marked to be eligible (spec 3.3).
REQUIRES_BASE: dict[ShiftType, BaseShift] = {
    "morning": "morning",
    "afternoon": "afternoon",
    "night": "night",
    "day12": "morning",
    "night12": "night",
}

# Hours from midnight of the shift's own day; night shifts run past 24.
START_H: dict[ShiftType, float] = {
    "morning": 6.75,
    "afternoon": 14.75,
    "night": 22.75,
    "day12": 6.75,
    "night12": 18.75,
}
END_H: dict[ShiftType, float] = {
    "morning": 14.75,
    "afternoon": 22.75,
    "night": 30.75,
    "day12": 18.75,
    "night12": 30.75,
}

HARD_REST = 8.0   # below this is physically impossible
FREE_REST = 12.0  # at or above this costs nothing
MAX_SHIFTS_PER_WEEK = 5


def rest_hours(prev: ShiftType, nxt: ShiftType) -> float:
    """Rest between a shift on day d and a shift on day d+1."""
    return 24.0 + START_H[nxt] - END_H[prev]


def segment_targets(morning_target: int) -> dict[Segment, int]:
    return {"S1": morning_target, "S2": 2, "S3": 2, "S4": 2}


def segment_floors(morning_target: int) -> dict[Segment, int]:
    return {"S1": 2 if morning_target == 3 else 1, "S2": 1, "S3": 1, "S4": 1}


class SolverWeights(BaseModel):
    floor: int = 1000
    kamut: int = 100
    target: int = 10
    rest8: int = 5
    pref: int = 1


class SolverGuard(BaseModel):
    id: str
    display_name: str | None = None
    # Already lowered by min(configured, available_days, 5) upstream.
    effective_kamut: int = Field(ge=0, le=5)
    can_work_12h_day: bool = False
    can_work_12h_night: bool = False
    # Day index "0".."6" (Sunday first) -> the base shifts they marked.
    availability: dict[str, list[BaseShift]] = Field(default_factory=dict)


class SolverInput(BaseModel):
    week_start: str
    morning_target_slots: Literal[2, 3] = 2
    guards: list[SolverGuard] = Field(default_factory=list)
    # guard_id -> shift worked last Saturday, for cross-week rest.
    carry_in: dict[str, ShiftType | None] = Field(default_factory=dict)
    weights: SolverWeights = Field(default_factory=SolverWeights)


class Assignment(BaseModel):
    day: int
    date: str
    shift: ShiftType
    guard_id: str


class FloorBreach(BaseModel):
    day: int
    segment: Segment
    required: int
    assigned: int


class TargetGap(BaseModel):
    day: int
    segment: Segment
    target: int
    assigned: int


class UnmetKamut(BaseModel):
    guard_id: str
    effective_kamut: int
    assigned: int


class RestViolation(BaseModel):
    guard_id: str
    day: int
    to: ShiftType
    hours: float
    from_: ShiftType = Field(alias="from")

    model_config = {"populate_by_name": True}


class CoverageReport(BaseModel):
    floor_breaches: list[FloorBreach] = Field(default_factory=list)
    target_gaps: list[TargetGap] = Field(default_factory=list)
    unmet_kamut: list[UnmetKamut] = Field(default_factory=list)
    rest_violations: list[RestViolation] = Field(default_factory=list)


class SolverOutput(BaseModel):
    status: str
    objective_value: int
    assignments: list[Assignment] = Field(default_factory=list)
    coverage_report: CoverageReport = Field(default_factory=CoverageReport)
