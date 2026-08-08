-- ============================================================================
-- Migration 26 : Manager-facing admin week cursor
--
-- ensure_roster_weeks() has always advanced its two tracked weeks (current,
-- current+7) at real Sunday 00:00 Asia/Jerusalem -- current_week_start()'s
-- pure calendar calculation. The configurable submission window (migration
-- 22) only ever flipped a locked/open status flag on whichever week already
-- happened to sit in the "next" slot; it never affected which weeks exist or
-- which one is labelled "current".
--
-- Ben's expectation was that the WHOLE manager-facing cycle -- archive the
-- outgoing week, promote next to current, reveal a new next -- should kick
-- in at each week's own configured open-time, not wait for real midnight.
--
-- Guard-facing visibility must NOT move with this: a guard should never lose
-- access to a roster for a day they are still actually working just because
-- the admin cursor has moved on. So this is purely additive -- a new
-- function used only by ensure_roster_weeks() and the manager dashboard's
-- week picker. current_week_start(), guard_visible_from() (migration 16)
-- and every RLS policy are untouched.
--
-- The formula: week W becomes the admin-current week at the instant its own
-- +7 week's submission window opens, i.e. at opens_for_week(W + 7). Solving
-- for the largest such Sunday W gives: take "today" (Asia/Jerusalem), step
-- it back one day if the time-of-day hasn't reached open_time yet (the
-- pivot), shift that pivot by (open_offset_days - 7) days, then take the
-- Sunday of the week containing the result -- the same "date minus its DOW"
-- trick current_week_start() already uses, applied to a shifted pivot
-- instead of the raw date. At open_offset_days=7, open_time=00:00 this
-- collapses to exactly current_week_start().
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_current_week_start()
RETURNS DATE
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT (b - EXTRACT(DOW FROM b)::INT)::DATE
    FROM (
      SELECT (pivot.p + (s.open_offset_days - 7)) AS b
        FROM scheduler_settings s,
        LATERAL (
          SELECT CASE
                   WHEN (NOW() AT TIME ZONE 'Asia/Jerusalem')::TIME >= s.open_time
                     THEN (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE
                   ELSE (NOW() AT TIME ZONE 'Asia/Jerusalem')::DATE - 1
                 END AS p
        ) pivot
       WHERE s.id
    ) t;
$$;

GRANT EXECUTE ON FUNCTION public.admin_current_week_start() TO authenticated;

COMMENT ON FUNCTION public.admin_current_week_start() IS
  'Manager-facing current/next cursor: advances at each week''s own submission open-time instead of real midnight. Guard-facing visibility (current_week_start(), guard_visible_from()) is untouched and stays calendar-pinned.';

-- ----------------------------------------------------------------------------
-- ensure_roster_weeks(): same body as migration 24, except v_current now
-- comes from the admin cursor instead of the raw calendar. Every row's own
-- opens_for_week()/deadline_for_week() still governs its individual status
-- transitions -- only which two weeks are tracked has changed.
-- ----------------------------------------------------------------------------
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
