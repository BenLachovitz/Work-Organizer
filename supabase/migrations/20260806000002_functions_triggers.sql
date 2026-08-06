-- ============================================================================
-- Migration 2/3 : Helper functions and triggers
-- Spec: dynamic-guard-scheduler-spec.md v2.0, section 7.1
-- ============================================================================

-- ----------------------------------------------------------------------------
-- is_manager()
--
-- SECURITY DEFINER is NOT optional here. In v1 of this spec the manager
-- policies inlined `EXISTS (SELECT 1 FROM profiles WHERE ...)`. That subquery
-- is itself subject to profiles' RLS; profiles had RLS enabled and zero
-- policies, so it returned no rows, EXISTS was always false, and managers were
-- silently locked out of every write they were supposed to own.
--
-- SECURITY DEFINER runs the body as the function owner, bypassing RLS on
-- profiles. `SET search_path = public, pg_temp` prevents a search_path
-- hijack -- without it a caller could shadow `profiles` with a temp table and
-- make this function return TRUE for anyone.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_manager()
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('manager', 'admin')
  );
$$;

REVOKE ALL ON FUNCTION public.is_manager() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_manager() TO authenticated;


-- ----------------------------------------------------------------------------
-- is_week_open(week_start)
--
-- The Thursday 20:00 submission lock (spec 3.5), enforced by the database
-- engine rather than by the UI. A guard who crafts a raw PostgREST call after
-- the deadline is refused just the same as one clicking a disabled button.
--
-- Returns FALSE for an unknown week, so preferences can never be attached to a
-- week the manager has not opened.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_week_open(p_week_start DATE)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(
    (SELECT status = 'open' AND NOW() < submission_deadline
       FROM public.roster_weeks
      WHERE week_start = p_week_start),
    FALSE
  );
$$;

REVOKE ALL ON FUNCTION public.is_week_open(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_week_open(DATE) TO authenticated;


-- ----------------------------------------------------------------------------
-- Privilege-escalation guard.
--
-- RLS decides WHICH ROWS you may update; it cannot express "you may update
-- this row but not these columns". Without this trigger, the
-- profiles_self_update policy would let any guard run
--     UPDATE profiles SET role = 'manager' WHERE id = auth.uid()
-- and promote themselves. A BEFORE UPDATE trigger is the column-level lock.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Managers may change these; guards may not. NULL auth.uid() means the
  -- service role / a migration is running, which is allowed to do anything.
  IF auth.uid() IS NOT NULL AND NOT public.is_manager() THEN
    IF NEW.role IS DISTINCT FROM OLD.role THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.role';
    END IF;
    IF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.is_active';
    END IF;
    IF NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.employee_code';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.id';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_guard_profile_columns
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_profile_columns();


-- ----------------------------------------------------------------------------
-- Keep weekly_submissions.updated_at honest.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_submissions_touch
  BEFORE UPDATE ON public.weekly_submissions
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();


-- ----------------------------------------------------------------------------
-- Stamp published_at whenever a run flips to published.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.stamp_published_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.is_published AND NOT COALESCE(OLD.is_published, FALSE) THEN
    NEW.published_at := NOW();
  ELSIF NOT NEW.is_published THEN
    NEW.published_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_runs_stamp_published
  BEFORE UPDATE ON public.schedule_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_published_at();


-- ----------------------------------------------------------------------------
-- next_run_version(week_start) -- convenience for the generate-schedule
-- Edge Function so it never races on the (week_start, version) unique key.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.next_run_version(p_week_start DATE)
RETURNS INT
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(MAX(version), 0) + 1
    FROM public.schedule_runs
   WHERE week_start = p_week_start;
$$;


-- ----------------------------------------------------------------------------
-- carry_in_shifts(week_start)
--
-- Closes the cross-week rest loophole (spec 2.8). Returns each guard's shift on
-- the Saturday immediately preceding p_week_start, taken from that week's
-- PUBLISHED run. The solver applies the full rest matrix between this shift and
-- the guard's Sunday assignment -- which is what stops a Saturday-night guard
-- being handed Sunday morning.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.carry_in_shifts(p_week_start DATE)
RETURNS TABLE (guard_id UUID, shift shift_type)
LANGUAGE SQL
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT a.guard_id, a.shift
    FROM public.schedule_assignments a
    JOIN public.schedule_runs r ON r.id = a.run_id
   WHERE r.is_published
     AND r.week_start = p_week_start - 7
     AND a.target_date = p_week_start - 1;   -- the preceding Saturday
$$;
