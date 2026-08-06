-- ============================================================================
-- Migration 1/3 : Types, tables and indexes
-- Dynamic Security Guard Shift Scheduler (סידור אמריקאי)
-- Spec: dynamic-guard-scheduler-spec.md v2.0, section 6
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ENUM TYPES
-- ----------------------------------------------------------------------------

-- The five assignable shift types across the two grids (spec 2.2).
CREATE TYPE shift_type AS ENUM ('morning', 'afternoon', 'night', 'day12', 'night12');

-- Guards only ever declare availability on the three 8h base shifts.
-- day12 / night12 eligibility is DERIVED from a base shift + a week-level
-- opt-in (spec 3.3), so they must not be selectable in the preference form.
CREATE TYPE base_shift AS ENUM ('morning', 'afternoon', 'night');

CREATE TYPE user_role AS ENUM ('admin', 'manager', 'guard');

CREATE TYPE week_status AS ENUM ('open', 'locked', 'generated', 'published');


-- ----------------------------------------------------------------------------
-- 1. roster_codes
--    Pre-seeded badge codes. Must exist BEFORE an auth.users row does, because
--    the first-login "claim" flow reads this table to decide whether a code is
--    legitimate. Written exclusively by the service role via Edge Function.
-- ----------------------------------------------------------------------------
CREATE TABLE roster_codes (
  employee_code TEXT PRIMARY KEY CHECK (employee_code ~ '^[0-9]{6}$'),
  display_name  TEXT NOT NULL,
  initial_role  user_role NOT NULL DEFAULT 'guard',
  -- Manager kill-switch: blocks claiming without deleting the code.
  claim_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  is_claimed    BOOLEAN NOT NULL DEFAULT FALSE,
  claimed_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE roster_codes IS
  'Pre-registered badge codes. No authenticated write policy exists, so codes '
  'cannot be enumerated or hijacked through PostgREST.';


-- ----------------------------------------------------------------------------
-- 2. profiles
--    employee_code is TEXT so leading zeros survive (e.g. 005396).
-- ----------------------------------------------------------------------------
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  employee_code TEXT NOT NULL UNIQUE CHECK (employee_code ~ '^[0-9]{6}$'),
  display_name  TEXT NOT NULL,
  role          user_role NOT NULL DEFAULT 'guard',
  -- Drives the dynamic roster size (6-12 registered, 8 active today).
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ----------------------------------------------------------------------------
-- 3. roster_weeks
--    One row per schedulable week. week_start must be a Sunday: the Israeli
--    work week starts Sunday and the solver indexes days 0..6 from it.
-- ----------------------------------------------------------------------------
CREATE TABLE roster_weeks (
  week_start           DATE PRIMARY KEY CHECK (EXTRACT(DOW FROM week_start) = 0),
  morning_target_slots INT NOT NULL DEFAULT 2 CHECK (morning_target_slots IN (2, 3)),
  -- Hard lock for guard edits. Default Thursday 20:00 Asia/Jerusalem (spec 3.5).
  submission_deadline  TIMESTAMPTZ NOT NULL,
  status               week_status NOT NULL DEFAULT 'open',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ----------------------------------------------------------------------------
-- 4. weekly_submissions
--    Exactly one row per guard per week. Its existence is what distinguishes
--    "submitted an empty sheet" from "never submitted" (spec 3.4) -- a state
--    that was unrepresentable in v1 of the schema.
--    The two 12h opt-ins live HERE (per week) rather than on every preference
--    row, so they can never self-contradict.
-- ----------------------------------------------------------------------------
CREATE TABLE weekly_submissions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id           UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start         DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  can_work_12h_day   BOOLEAN NOT NULL DEFAULT FALSE,
  can_work_12h_night BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guard_id, week_start)
);


-- ----------------------------------------------------------------------------
-- 5. weekly_wish_preferences
--    Row present  == guard is available for that base shift.
--    Row absent   == unavailable.
--    There is deliberately no is_available boolean: two ways to express the
--    same fact is two ways to disagree.
-- ----------------------------------------------------------------------------
CREATE TABLE weekly_wish_preferences (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  week_start  DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  shift       base_shift NOT NULL,
  -- Reserved for the 2-level scale (יכול / מעדיף). POC writes 1 always, so the
  -- feature can be switched on later with no migration (spec 3.1).
  strength    SMALLINT NOT NULL DEFAULT 1 CHECK (strength IN (1, 2)),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (guard_id, target_date, shift),
  -- A preference cannot escape its own week.
  CONSTRAINT date_within_week
    CHECK (target_date >= week_start AND target_date <= week_start + 6)
);


-- ----------------------------------------------------------------------------
-- 6. weekly_guard_targets
--    The כמות column, relational rather than a JSONB blob, so it gets real
--    foreign keys, per-guard RLS and an auditable override trail.
--    effective_kamut = min(configured_kamut, distinct_available_days, 5),
--    computed at generation time (spec 2.7). NULL until a run happens.
-- ----------------------------------------------------------------------------
CREATE TABLE weekly_guard_targets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start       DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  guard_id         UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  configured_kamut INT NOT NULL DEFAULT 0 CHECK (configured_kamut BETWEEN 0 AND 5),
  effective_kamut  INT CHECK (effective_kamut BETWEEN 0 AND 5),
  UNIQUE (week_start, guard_id)
);


-- ----------------------------------------------------------------------------
-- 7. schedule_runs
--    One row per solver execution. Versioned, so a manager can generate
--    several drafts and compare them before publishing.
-- ----------------------------------------------------------------------------
CREATE TABLE schedule_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  week_start      DATE NOT NULL REFERENCES roster_weeks(week_start) ON DELETE CASCADE,
  version         INT NOT NULL,
  solver_status   TEXT NOT NULL,   -- OPTIMAL | FEASIBLE | INFEASIBLE | MOCK
  objective_value INT,
  -- floor_breaches, target_gaps, unmet_kamut, rest_violations, kamut_overrides
  coverage_report JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_published    BOOLEAN NOT NULL DEFAULT FALSE,
  generated_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at    TIMESTAMPTZ,
  UNIQUE (week_start, version)
);

-- At most one published roster per week. A partial unique index expresses this
-- exactly; the v1 is_draft boolean could not.
CREATE UNIQUE INDEX one_published_run_per_week
  ON schedule_runs (week_start) WHERE is_published;


-- ----------------------------------------------------------------------------
-- 8. schedule_assignments
--    `post` (סריקה/בוטקה/בקרה/שמירה) is nullable and set MANUALLY by the
--    manager after generation. The solver never touches it (spec 1.1 #8).
-- ----------------------------------------------------------------------------
CREATE TABLE schedule_assignments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      UUID NOT NULL REFERENCES schedule_runs(id) ON DELETE CASCADE,
  target_date DATE NOT NULL,
  shift       shift_type NOT NULL,
  guard_id    UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post        TEXT CHECK (post IN ('סריקה', 'בוטקה', 'בקרה', 'שמירה')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, target_date, shift, guard_id)
);

-- Enforces "at most one shift per guard per day" (H3) at the storage layer too,
-- so a careless manual override cannot violate what the solver guarantees.
CREATE UNIQUE INDEX one_shift_per_guard_per_day
  ON schedule_assignments (run_id, target_date, guard_id);


-- ----------------------------------------------------------------------------
-- INDEXES
-- ----------------------------------------------------------------------------
CREATE INDEX idx_prefs_week        ON weekly_wish_preferences (week_start, guard_id);
CREATE INDEX idx_prefs_guard       ON weekly_wish_preferences (guard_id);
CREATE INDEX idx_subs_week         ON weekly_submissions (week_start);
CREATE INDEX idx_targets_week      ON weekly_guard_targets (week_start);
CREATE INDEX idx_runs_week_pub     ON schedule_runs (week_start, is_published);
CREATE INDEX idx_assign_run_date   ON schedule_assignments (run_id, target_date);
CREATE INDEX idx_assign_guard      ON schedule_assignments (guard_id);
CREATE INDEX idx_profiles_active   ON profiles (is_active) WHERE is_active;
