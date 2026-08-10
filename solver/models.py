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
# The highest number of shifts ANY guard may ever reach in a week -- one more
# than the ordinary ceiling. Only reachable by a guard already AT the
# ordinary ceiling who explicitly asks for one more (see SolverGuard.max_shifts
# and maxRequestableShifts() in src/lib/shifts.ts).
ABSOLUTE_MAX_SHIFTS_PER_WEEK = 6


def rest_hours(prev: ShiftType, nxt: ShiftType) -> float:
    """Rest between a shift on day d and a shift on day d+1."""
    return 24.0 + START_H[nxt] - END_H[prev]


# American school: Sunday (0) and Saturday (6) are the days off. The roster
# week still starts on Sunday, which leaves Mon..Fri as the contiguous block
# 1..5 that the raised morning target applies to.
WEEKEND_DAYS = (0, 6)


def is_weekend_day(day_index: int) -> bool:
    return day_index in WEEKEND_DAYS


def morning_target_for_day(
    week_setting: int, day_index: int, overrides: dict[str, int] | None = None
) -> int:
    """The raised target (3) applies Mon-Fri only; the weekend always runs 2.

    `overrides` is a sparse day_index (as a string, matching the wire format)
    -> target map for THIS week only, e.g. a holiday week needing Mon-Wed at
    2 but Thu-Fri at 3. A day with no entry just follows week_setting. Never
    consulted for the weekend -- see morningTargetForDay() in
    src/lib/shifts.ts, this is its mirror.
    """
    if is_weekend_day(day_index):
        return 2
    if overrides:
        override = overrides.get(str(day_index))
        if override is not None:
            return override
    return week_setting


def segment_targets(
    week_setting: int, day_index: int, overrides: dict[str, int] | None = None
) -> dict[Segment, int]:
    return {
        "S1": morning_target_for_day(week_setting, day_index, overrides),
        "S2": 2,
        "S3": 2,
        "S4": 2,
    }


def segment_floors(
    week_setting: int, day_index: int, overrides: dict[str, int] | None = None
) -> dict[Segment, int]:
    morning = morning_target_for_day(week_setting, day_index, overrides)
    return {"S1": 2 if morning == 3 else 1, "S2": 1, "S3": 1, "S4": 1}


# Segment lengths in hours (spec 2.3). S1/S4 are the 8h morning/night windows;
# S2/S3 are the two 4h halves of the afternoon.
SEGMENT_HOURS: dict[Segment, int] = {"S1": 8, "S2": 4, "S3": 4, "S4": 8}


def segment_weight(segment: Segment) -> int:
    """How much a segment's floor/target gap should weigh, relative to the
    shortest segment (4h). Mirrors segmentWeight() in src/lib/shifts.ts --
    see that docstring for why this exists."""
    return SEGMENT_HOURS[segment] // 4


def segment_penalty_weight(segment: Segment, morning_priority_bonus: int) -> int:
    """segment_weight() plus a flat morning-specific priority bonus, for the
    floor/target penalty terms ONLY -- never the coverage numbers themselves
    (segment_targets/segment_floors, unaffected). ADDITIVE, not a multiplier,
    like every other weight -- CP-SAT's coefficients must be integers.
    Mirrors segmentPenaltyWeight() in src/lib/shifts.ts -- see that docstring
    for the full rationale."""
    base = segment_weight(segment)
    return base + morning_priority_bonus if segment == "S1" else base


class SolverWeights(BaseModel):
    floor: int = 1000
    kamut: int = 100
    target: int = 10
    rest8: int = 5
    pref: int = 1
    # Added on top of `pref` for a slot marked עדיפות (strength 2). Kept below
    # rest8/target so it can only break ties, never outweigh a real rule
    # (measured trade-off: see the comment on WEIGHTS in src/lib/shifts.ts).
    preferred: int = 2
    # Bonus for a shift beyond a guard's effective_kamut, up to their own
    # stretch_target -- the requested-shift-count analogue of `preferred`.
    # Starting value only, not yet measured against live data (see the
    # comment on WEIGHTS.stretch in src/lib/shifts.ts).
    stretch: int = 1
    # Flat bonus ADDED to segment_weight('S1') in the floor/target penalty
    # terms only -- see segment_penalty_weight() above. Defaults to 0
    # (neutral), NOT the shipped production value (WEIGHTS.morning_priority
    # = 1 in src/lib/shifts.ts) -- see the matching comment on
    # morning_priority in src/lib/solverContract.ts for why: this adds to a
    # term present in almost every fixture, including ones predating this
    # field whose expected behaviour assumes segments are otherwise
    # symmetric.
    morning_priority: int = 0


class SolverGuard(BaseModel):
    id: str
    display_name: str | None = None
    # Already lowered by min(configured, available_days, 5) upstream.
    effective_kamut: int = Field(ge=0, le=5)
    # The rewarded (never penalized) ceiling for this guard -- always intended
    # to be >= effective_kamut when both are meaningfully set. Already derived
    # upstream (stretchTarget() in src/lib/shifts.ts) from the guard's own
    # requested shift count; this solver never sees the raw request or
    # configured_kamut, only these two pre-derived numbers.
    stretch_target: int = Field(ge=0, le=6, default=0)
    # This guard's hard weekly ceiling (H4) -- ordinarily the flat
    # MAX_SHIFTS_PER_WEEK everyone shares, but tightened to the guard's own
    # requested count when they explicitly asked for FEWER shifts than
    # configured, or (only for a guard already configured at the ordinary
    # ceiling) raised to ABSOLUTE_MAX_SHIFTS_PER_WEEK when they explicitly
    # asked for one more (guardShiftCeiling() in src/lib/shifts.ts).
    max_shifts: int = Field(ge=0, le=ABSOLUTE_MAX_SHIFTS_PER_WEEK, default=MAX_SHIFTS_PER_WEEK)
    # Day index "0".."6" (Sunday first) -> the base shifts they marked.
    availability: dict[str, list[BaseShift]] = Field(default_factory=dict)
    # Day index -> the base shifts marked עדיפות (strength 2) that day. Always
    # a subset of availability for the same day.
    preferred: dict[str, list[BaseShift]] = Field(default_factory=dict)
    # Day indices the guard will extend to 12h. Per day, not per week:
    #   day12 on day d  <=>  "morning" in availability[d] and d in twelve_hour_day
    twelve_hour_day: list[int] = Field(default_factory=list)
    twelve_hour_night: list[int] = Field(default_factory=list)


class SolverInput(BaseModel):
    week_start: str
    morning_target_slots: Literal[2, 3] = 2
    # Sparse day_index (as a string) -> target override for THIS week only.
    # See morning_target_for_day() above.
    morning_target_overrides: dict[str, Literal[2, 3]] = Field(default_factory=dict)
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
