-- ============================================================================
-- Migration 27 : Keep an untouched "next" week's deadline live
--
-- submission_deadline has only ever been set once, at the moment
-- ensure_roster_weeks() first inserts a roster_weeks row (migration 9,
-- carried through since) -- deliberately, per spec SS12.5: changing the
-- scheduler_settings offsets/times is forward-looking, so an existing week's
-- stored deadline is not rewritten retroactively, and the lock/reopen flow
-- (SS12.3) is how a manager changes ONE SPECIFIC week's deadline right now.
--
-- That was too strict in one specific case Ben hit: the week currently
-- occupying the "next" slot -- the one actually open for submissions right
-- now -- with nobody having decided anything about it (status_overridden_at
-- IS NULL). Nothing about that week represents a human decision to KEEP its
-- current deadline; it is just whatever ensure_roster_weeks() happened to
-- compute when the row was first created. Changing the submission-window
-- settings should be felt by that week too, not only by weeks created after
-- the change.
--
-- Scoped to v_next only, not v_current: v_current is always inserted
-- already past its own deadline (spec SS2.4a -- it is the week already in
-- progress), so there is nothing meaningful to refresh there. And scoped to
-- status_overridden_at IS NULL AND status NOT IN ('generated', 'published')
-- -- exactly the same "has a human decided anything here" gate the existing
-- open/lock sweep below already uses, so a manager's explicit action still
-- beats automation (BACKLOG.md's "three habits worth keeping").
--
-- Runs BEFORE the open/lock sweep so a deadline that just moved into the
-- past (a manager tightening it) is reflected in the very same
-- ensure_roster_weeks() call that locks the week for it, not one call later.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ensure_roster_weeks()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_current DATE := public.admin_current_week_start();
  v_next    DATE := v_current + 7;
  v_target  INT;
BEGIN
  SELECT default_morning_target_slots INTO v_target
    FROM scheduler_settings WHERE id;

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

  -- Keep v_next's deadline in step with live settings, as long as nobody has
  -- decided anything about it and it has not moved past the submission
  -- phase. See the migration header for why this is scoped to v_next only.
  UPDATE roster_weeks w
     SET submission_deadline = public.deadline_for_week(w.week_start)
   WHERE w.week_start = v_next
     AND w.status_overridden_at IS NULL
     AND w.status NOT IN ('generated', 'published');

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
