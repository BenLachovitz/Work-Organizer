-- ============================================================================
-- Migration 19 : Per-guard default כמות
--
-- Every week currently starts every guard at כמות 0, so the manager re-enters
-- the same steady-state numbers (5, 5, 4, 5, 5, 3, 2, 2) by hand every week.
-- That is not a per-week decision, it is a per-guard baseline that only
-- occasionally needs a per-week override -- which is exactly what the
-- Stepper on the team table is already for (spec §3, TeamTable.tsx). This
-- migration only changes where a NEW week's starting numbers come from; the
-- weekly override path is untouched.
--
-- The default lives on `profiles`, one column, because it is a property of
-- the guard, not of any week. `weekly_guard_targets.configured_kamut` stays
-- the per-week source of truth -- this only decides what that row is
-- SEEDED with when it does not exist yet.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN default_kamut SMALLINT NOT NULL DEFAULT 0
    CHECK (default_kamut BETWEEN 0 AND 5);

COMMENT ON COLUMN profiles.default_kamut IS
  'Baseline weekly כמות for this guard. Seeds weekly_guard_targets.configured_kamut for a week/guard pair that does not have a row yet; never overwrites one that does.';

-- The team's current baselines, set by the manager 2026-08-08. New guards
-- start at 0 until told otherwise -- see the seed.sql comment on roster_codes
-- for why placeholder codes have no profile (and so nothing to update) yet.
UPDATE profiles SET default_kamut = 5 WHERE display_name = 'יובל';
UPDATE profiles SET default_kamut = 5 WHERE display_name = 'ים';
UPDATE profiles SET default_kamut = 4 WHERE display_name = 'עידן';
UPDATE profiles SET default_kamut = 5 WHERE display_name = 'שלי';
UPDATE profiles SET default_kamut = 5 WHERE display_name = 'לוק';
UPDATE profiles SET default_kamut = 3 WHERE display_name = 'הודיה';
UPDATE profiles SET default_kamut = 2 WHERE display_name = 'ניתאי';
UPDATE profiles SET default_kamut = 2 WHERE display_name = 'בן';


-- ----------------------------------------------------------------------------
-- ensure_roster_weeks(): after the two live roster_weeks rows exist, seed a
-- weekly_guard_targets row for every active guard who does not already have
-- one for that week -- ON CONFLICT DO NOTHING, so a value the manager already
-- set (by hand, or from a previous run of this same seed) is never touched.
--
-- This covers new weeks rolling in AND a guard registering mid-week: either
-- way, "no row yet" is exactly the condition under which a default belongs.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ensure_roster_weeks()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current DATE := public.current_week_start();
  v_next    DATE := v_current + 7;
  v_target  INT;
BEGIN
  SELECT morning_target_slots INTO v_target
    FROM roster_weeks ORDER BY week_start DESC LIMIT 1;
  v_target := COALESCE(v_target, 2);

  -- The week in progress. Its own submission window closed long ago.
  INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
  VALUES (v_current, v_target, public.deadline_for_week(v_current), 'locked')
  ON CONFLICT (week_start) DO NOTHING;

  -- The week being filled in. Open only once its Saturday 20:00 has arrived.
  INSERT INTO roster_weeks (week_start, morning_target_slots, submission_deadline, status)
  VALUES (
    v_next,
    v_target,
    public.deadline_for_week(v_next),
    (CASE
       WHEN NOW() >= public.opens_for_week(v_next)
        AND NOW() <  public.deadline_for_week(v_next) THEN 'open'
       ELSE 'locked'
     END)::week_status
  )
  ON CONFLICT (week_start) DO NOTHING;

  -- Keep the two live weeks in step with their windows -- but never touch a
  -- week a manager has decided about, and never a generated or published one.
  UPDATE roster_weeks w
     SET status = 'open'
   WHERE w.week_start IN (v_current, v_next)
     AND w.status = 'locked'
     AND w.status_overridden_at IS NULL
     AND NOW() >= public.opens_for_week(w.week_start)
     AND NOW() <  w.submission_deadline;

  UPDATE roster_weeks w
     SET status = 'locked'
   WHERE w.week_start IN (v_current, v_next)
     AND w.status = 'open'
     AND w.status_overridden_at IS NULL
     AND w.submission_deadline <= NOW();

  -- Seed this week's כמות from each guard's baseline, wherever it is missing.
  INSERT INTO weekly_guard_targets (week_start, guard_id, configured_kamut)
  SELECT wk.week_start, p.id, p.default_kamut
    FROM (VALUES (v_current), (v_next)) AS wk(week_start)
    CROSS JOIN profiles p
   WHERE p.is_active
  ON CONFLICT (week_start, guard_id) DO NOTHING;
END;
$$;

GRANT EXECUTE ON FUNCTION public.ensure_roster_weeks() TO authenticated;

SELECT public.ensure_roster_weeks();
