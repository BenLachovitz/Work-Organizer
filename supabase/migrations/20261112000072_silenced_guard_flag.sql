-- ============================================================================
-- Migration 72 : profiles.is_silenced -- the reversible "support-mode" flag
--
-- Deliberately profiles-only -- no roster_codes mirror and no claim-time copy
-- trigger, unlike default_kamut/is_demo/phone_number's dual-column shape.
-- Those are all set BEFORE a code is ever claimed; silencing only ever makes
-- sense for an employee who already has a live profile -- nobody silences an
-- unclaimed invitation.
--
-- Untouched by this: is_active (silencing never deactivates the account),
-- role (a silenced manager still manages; a silenced guard is still a
-- guard), and login (nothing here blocks any page). It only changes what the
-- automated systems expect of this guard and what the manager-facing
-- tracking shows.
-- ============================================================================

ALTER TABLE profiles
  ADD COLUMN is_silenced BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN profiles.is_silenced IS
  'True when a manager has opted this guard out of weekly-submission tracking, reminder/broadcast notifications, and the solver''s candidate list -- without touching is_active or role, and without blocking login or any page. Reversible. No roster_codes mirror: silencing only ever applies to an already-claimed profile.';

-- ----------------------------------------------------------------------------
-- Extend the column-level privilege-escalation guard (migration 2) to cover
-- is_silenced -- profiles_self_update (migration 3) is row-scoped only
-- (id = auth.uid()), with no column restriction, so without this a guard
-- could silence or un-silence themselves (e.g. opting out of their own
-- "hasn't submitted" tracking and reminders). CREATE OR REPLACE of the exact
-- same function/trigger binding, one more IF block added to the existing
-- four.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_profile_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
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
    IF NEW.is_silenced IS DISTINCT FROM OLD.is_silenced THEN
      RAISE EXCEPTION 'insufficient privilege: cannot modify profiles.is_silenced';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ----------------------------------------------------------------------------
-- broadcast_targets()/unsubmitted_targets() (migration 40) -- exclude a
-- silenced guard from every automated push. broadcast_targets() is shared by
-- both the weekly deadline-announcement broadcast and the roster-published
-- broadcast (send-notifications/index.ts), so excluding it here silences a
-- flagged guard from both -- matching "excluded from everything automated,"
-- not just the personal reminders.
--
-- role is untouched: a silenced guard who is ALSO a manager keeps receiving
-- manager_targets() (migration 45) notifications about other guards
-- submitting/cancelling -- that's role-driven, orthogonal to silencing.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_targets()
RETURNS TABLE (guard_id UUID)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM profiles WHERE is_active AND NOT is_demo AND NOT is_silenced;
$$;

-- No role filter: a manager is also a real, active guard who submits their
-- own availability (spec 2.1). Filtering to role='guard' would silently
-- exclude them from their own reminders.
CREATE OR REPLACE FUNCTION public.unsubmitted_targets(p_week_start DATE)
RETURNS TABLE (guard_id UUID)
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT p.id
    FROM profiles p
   WHERE p.is_active AND NOT p.is_demo AND NOT p.is_silenced
     AND NOT EXISTS (
       SELECT 1 FROM weekly_submissions ws
        WHERE ws.guard_id = p.id AND ws.week_start = p_week_start
     );
$$;

REVOKE ALL ON FUNCTION public.broadcast_targets() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.unsubmitted_targets(DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.broadcast_targets() TO authenticated;
GRANT EXECUTE ON FUNCTION public.unsubmitted_targets(DATE) TO authenticated;
