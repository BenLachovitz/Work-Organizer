-- ============================================================================
-- Migration 22 : Configurable submission window
--
-- The submission deadline (Wednesday 19:00) and the opening of the next
-- week's window (Saturday 20:00) were literals baked into deadline_for_week()
-- and opens_for_week(). The manager needs to move these sometimes -- a
-- schedule that shifts a week here and there is normal, not a one-off.
--
-- A single-row settings table holds each as (offset_days, time), matching the
-- arithmetic those two functions already did (`week_start - N days`, at time
-- T) rather than inventing a new representation. The UI converts a manager-
-- friendly "day of week" into this offset; the database only ever sees the
-- offset, so the arithmetic that used to be a literal is now a lookup and
-- nothing else about deadline_for_week's callers has to change.
--
-- Changing a setting affects weeks CREATED FROM NOW ON -- ensure_roster_weeks()
-- calls these functions only when it inserts a new roster_weeks row or (for
-- the open/lock sweep) compares against the row's already-stored deadline. An
-- already-existing week's stored submission_deadline is not rewritten
-- retroactively; the existing lock/reopen flow (migration 11-12) is still how
-- a manager changes one specific week's deadline right now.
-- ============================================================================

CREATE TABLE scheduler_settings (
  -- A CHECK on a constant forces exactly one row -- simpler than a lookup key
  -- nothing else ever needs.
  id                    BOOLEAN NOT NULL PRIMARY KEY DEFAULT TRUE CHECK (id),
  deadline_offset_days  SMALLINT NOT NULL DEFAULT 4 CHECK (deadline_offset_days BETWEEN 1 AND 20),
  deadline_time         TIME     NOT NULL DEFAULT '19:00',
  open_offset_days      SMALLINT NOT NULL DEFAULT 8 CHECK (open_offset_days BETWEEN 1 AND 20),
  open_time             TIME     NOT NULL DEFAULT '20:00',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- "Opens" must land strictly before "deadline" in absolute time. Both are
  -- counted as days-before-week_start, so a LARGER offset is EARLIER --
  -- open_offset_days must exceed deadline's, or (same day) open earlier in
  -- the day.
  CONSTRAINT open_before_deadline CHECK (
    open_offset_days > deadline_offset_days
    OR (open_offset_days = deadline_offset_days AND open_time < deadline_time)
  )
);

INSERT INTO scheduler_settings (id) VALUES (TRUE);

COMMENT ON TABLE scheduler_settings IS
  'Singleton. Governs when a week''s submission window opens and closes -- see deadline_for_week() / opens_for_week().';

GRANT SELECT, UPDATE ON scheduler_settings TO authenticated;

ALTER TABLE scheduler_settings ENABLE ROW LEVEL SECURITY;

-- Readable by everyone, same as roster_weeks -- it is scheduling config, not
-- anything sensitive, and a guard reading it exposes nothing an already-
-- published deadline on roster_weeks doesn't.
CREATE POLICY settings_read ON scheduler_settings
  FOR SELECT TO authenticated
  USING (TRUE);

CREATE POLICY settings_manager_write ON scheduler_settings
  FOR UPDATE TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());


-- ----------------------------------------------------------------------------
-- deadline_for_week / opens_for_week: read the offset and time from settings
-- instead of a literal. STABLE, not IMMUTABLE -- their result can now change
-- between calls if a manager edits the settings row, and IMMUTABLE tells the
-- planner it is safe to cache or fold a call forever, which would go stale
-- the moment settings change.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.deadline_for_week(p_week_start DATE)
RETURNS TIMESTAMPTZ
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT ((p_week_start - s.deadline_offset_days)::TEXT || ' ' || s.deadline_time::TEXT)::TIMESTAMP
           AT TIME ZONE 'Asia/Jerusalem'
    FROM public.scheduler_settings s WHERE s.id;
$$;

GRANT EXECUTE ON FUNCTION public.deadline_for_week(DATE) TO authenticated;

CREATE OR REPLACE FUNCTION public.opens_for_week(p_week_start DATE)
RETURNS TIMESTAMPTZ
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT ((p_week_start - s.open_offset_days)::TEXT || ' ' || s.open_time::TEXT)::TIMESTAMP
           AT TIME ZONE 'Asia/Jerusalem'
    FROM public.scheduler_settings s WHERE s.id;
$$;

GRANT EXECUTE ON FUNCTION public.opens_for_week(DATE) TO authenticated;
