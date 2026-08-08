-- ============================================================================
-- Migration 20 : Manager team management -- add, remove, edit defaults
--
-- Until now, adding a badge code or changing who counts as active meant
-- running SQL by hand. This gives the manager a real CRUD surface for the
-- team, entirely through RLS the client already trusts -- no new Edge
-- Function, and no change to claim-code, the one publicly-reachable
-- unauthenticated write path in the system (see its own docstring on why
-- that file is treated as hostile-input territory and touched as rarely as
-- possible).
--
-- Three operations, three different existing mechanisms:
--
--   REMOVE   profiles.is_active already exists and already means exactly
--            this ("Drives the dynamic roster size", migration 1). Setting
--            it false already fully removes a guard from scheduling
--            (useManagerWeek filters is_active) and from the solver's guard
--            list -- and profiles_manager_write + the guard_profile_columns
--            trigger (migration 2) already let a manager flip it. Nothing to
--            add here but the UI. Deliberately NOT a hard DELETE: schedule_
--            assignments, weekly_wish_preferences etc. all cascade from
--            guard_id, so deleting the row would erase that person's
--            history out of every past, including PUBLISHED, roster.
--            Deactivation is reversible; erasing history is not.
--
--   ADD      roster_codes is how every guard has ever been registered --
--            seed.sql just did it with SQL. This grants managers the same
--            capability through the API instead of through me.
--
--   DEFAULT  profiles.default_kamut (migration 19) already seeds a new
--            week's כמות. This adds the same column to roster_codes, so a
--            baseline can be set BEFORE someone has claimed their code, and
--            a trigger carries it onto profiles at the moment they do.
-- ============================================================================

ALTER TABLE roster_codes
  ADD COLUMN default_kamut SMALLINT NOT NULL DEFAULT 0
    CHECK (default_kamut BETWEEN 0 AND 5);

COMMENT ON COLUMN roster_codes.default_kamut IS
  'Baseline weekly כמות, set before the employee has claimed their code. Copied onto profiles.default_kamut at claim time by trg_profiles_default_kamut; has no further effect afterwards.';

-- ----------------------------------------------------------------------------
-- Carry the baseline from roster_codes to profiles at the moment a profile is
-- created -- i.e. the moment claim-code's admin client inserts one. This is a
-- database trigger rather than a change to that function specifically so the
-- one publicly-reachable unauthenticated endpoint in the system stays
-- untouched; the guarantee holds no matter who or what inserts the row.
--
-- COALESCE'd rather than unconditional: a profiles row created with no
-- matching roster_codes entry (test fixtures, mainly) keeps whatever value it
-- was given instead of being forced to a lookup that finds nothing.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.copy_default_kamut()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.default_kamut := COALESCE(
    (SELECT default_kamut FROM roster_codes WHERE employee_code = NEW.employee_code),
    NEW.default_kamut
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_default_kamut
  BEFORE INSERT ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.copy_default_kamut();


-- ----------------------------------------------------------------------------
-- roster_codes gets a manager write policy. Until now nothing but the service
-- role could write here at all ("No write policy exists for `authenticated`",
-- migration 3) -- codes could only be minted by me running SQL. This is the
-- same FOR-ALL-managers-only shape as every other manager_write policy in the
-- schema (profiles, roster_weeks, weekly_submissions, ...); it does not
-- change what a GUARD can do, since is_manager() is still false for them.
-- ----------------------------------------------------------------------------
GRANT INSERT, UPDATE, DELETE ON roster_codes TO authenticated;

CREATE POLICY codes_manager_write ON roster_codes
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());

COMMENT ON TABLE roster_codes IS
  'Pre-registered badge codes. Managers may create, edit and delete rows (codes_manager_write); nobody else can read or write it through PostgREST, so a code cannot be enumerated or hijacked -- only probed one at a time through the rate-limited claim-code function.';


-- ----------------------------------------------------------------------------
-- roster_code_status: add default_kamut, coalesced so the manager's team-list
-- query gets one column regardless of whether the row is still pre-claim
-- (roster_codes.default_kamut) or a real profile (profiles.default_kamut,
-- the live, editable value from then on).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW roster_code_status
WITH (security_invoker = true) AS
SELECT c.employee_code,
       c.display_name,
       c.initial_role,
       c.is_claimed,
       c.claim_enabled,
       c.claimed_at,
       p.id AS profile_id,
       p.is_active,
       COALESCE(p.default_kamut, c.default_kamut) AS default_kamut
  FROM roster_codes c
  LEFT JOIN profiles p ON p.employee_code = c.employee_code;

GRANT SELECT ON roster_code_status TO authenticated;
