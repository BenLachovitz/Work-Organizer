-- ============================================================================
-- Migration 3/3 : Row-Level Security
-- Spec: dynamic-guard-scheduler-spec.md v2.0, section 7.2
--
-- Threat model: the anon key IS public -- it ships inside the JavaScript bundle
-- on every guard's phone. Anyone can extract it and hit PostgREST directly with
-- hand-written queries. Therefore EVERY table below must be safe under the
-- assumption that the attacker is a legitimately authenticated guard issuing
-- arbitrary SQL-equivalent REST calls. The UI is not a security boundary.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Baseline privileges. RLS filters rows; GRANT decides whether you may touch
-- the table at all. Both are needed -- RLS on a table with no GRANT is
-- unreachable, and a GRANT with no RLS is wide open.
-- ----------------------------------------------------------------------------

-- anon can do nothing. Login runs through the claim-code Edge Function using
-- the service role, so the unauthenticated client never needs table access.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;

GRANT SELECT                         ON roster_codes            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON profiles                TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON roster_weeks            TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_submissions      TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_wish_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON weekly_guard_targets    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_runs           TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON schedule_assignments    TO authenticated;

ALTER TABLE roster_codes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_weeks            ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_submissions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_wish_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_guard_targets    ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_assignments    ENABLE ROW LEVEL SECURITY;


-- ----------------------------------------------------------------------------
-- roster_codes -- managers may audit claim status. NO write policy exists for
-- `authenticated`, so unclaimed badge codes cannot be listed, altered or
-- hijacked through the API. Only the service role writes here.
-- ----------------------------------------------------------------------------
CREATE POLICY codes_manager_read ON roster_codes
  FOR SELECT TO authenticated
  USING (is_manager());


-- ----------------------------------------------------------------------------
-- profiles -- names must be readable by everyone or the roster grid renders as
-- a wall of UUIDs. Writes are self-only, and the trg_guard_profile_columns
-- trigger (migration 2) blocks role/is_active/employee_code escalation.
-- ----------------------------------------------------------------------------
CREATE POLICY profiles_read ON profiles
  FOR SELECT TO authenticated
  USING (TRUE);

CREATE POLICY profiles_self_update ON profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY profiles_manager_write ON profiles
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());


-- ----------------------------------------------------------------------------
-- roster_weeks -- guards read the deadline and the morning target; only
-- managers change them. A guard rewriting submission_deadline would defeat the
-- entire submission lock, so this one matters.
-- ----------------------------------------------------------------------------
CREATE POLICY weeks_read ON roster_weeks
  FOR SELECT TO authenticated
  USING (TRUE);

CREATE POLICY weeks_manager_write ON roster_weeks
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());


-- ----------------------------------------------------------------------------
-- weekly_submissions -- own row only, and only while the week is open.
-- Managers read every row (the dashboard needs to show who has not submitted).
-- ----------------------------------------------------------------------------
CREATE POLICY subs_read ON weekly_submissions
  FOR SELECT TO authenticated
  USING (guard_id = auth.uid() OR is_manager());

CREATE POLICY subs_self_write ON weekly_submissions
  FOR ALL TO authenticated
  USING      (guard_id = auth.uid() AND is_week_open(week_start))
  WITH CHECK (guard_id = auth.uid() AND is_week_open(week_start));

CREATE POLICY subs_manager_write ON weekly_submissions
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());


-- ----------------------------------------------------------------------------
-- weekly_wish_preferences -- the same pattern.
--
-- The manager SELECT policy here is load-bearing: without it the manager
-- dashboard renders empty, because v1's only policy was `auth.uid() = guard_id`
-- which excludes the manager from everyone else's rows.
--
-- The is_week_open() predicate appears in BOTH USING and WITH CHECK. USING
-- gates which existing rows may be updated/deleted; WITH CHECK gates the rows
-- being written. Omitting either leaves the deadline half-enforced.
-- ----------------------------------------------------------------------------
CREATE POLICY prefs_read ON weekly_wish_preferences
  FOR SELECT TO authenticated
  USING (guard_id = auth.uid() OR is_manager());

CREATE POLICY prefs_self_write ON weekly_wish_preferences
  FOR ALL TO authenticated
  USING      (guard_id = auth.uid() AND is_week_open(week_start))
  WITH CHECK (guard_id = auth.uid() AND is_week_open(week_start));

CREATE POLICY prefs_manager_write ON weekly_wish_preferences
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());


-- ----------------------------------------------------------------------------
-- weekly_guard_targets -- a guard may SEE their own כמות but never set it.
-- There is deliberately no self-write policy.
-- ----------------------------------------------------------------------------
CREATE POLICY targets_read ON weekly_guard_targets
  FOR SELECT TO authenticated
  USING (guard_id = auth.uid() OR is_manager());

CREATE POLICY targets_manager_write ON weekly_guard_targets
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());


-- ----------------------------------------------------------------------------
-- schedule_runs -- drafts are manager-only; guards see a run once published.
-- ----------------------------------------------------------------------------
CREATE POLICY runs_read ON schedule_runs
  FOR SELECT TO authenticated
  USING (is_published OR is_manager());

CREATE POLICY runs_manager_write ON schedule_runs
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());


-- ----------------------------------------------------------------------------
-- schedule_assignments -- visibility is inherited from the parent run, so an
-- unpublished draft never leaks a single assignment row.
-- ----------------------------------------------------------------------------
CREATE POLICY assign_read ON schedule_assignments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM schedule_runs r
      WHERE r.id = schedule_assignments.run_id
        AND (r.is_published OR is_manager())
    )
  );

CREATE POLICY assign_manager_write ON schedule_assignments
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());
