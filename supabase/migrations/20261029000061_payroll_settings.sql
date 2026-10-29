-- ============================================================================
-- Migration 61 : Payroll settings (estimated gross salary feature)
--
-- Everyone on the team is paid the same flat hourly rate except the manager,
-- who has their own -- not a per-individual rate. A singleton settings row,
-- same shape as scheduler_settings (migration 22), holds both.
--
-- Deliberately no guard-read policy on the table itself: the manager's own
-- rate is personal, and a guard never needs the raw row -- my_hourly_rate()
-- below resolves to the CALLER's own effective rate without ever exposing
-- the other one.
-- ============================================================================

CREATE TABLE payroll_settings (
  -- A CHECK on a constant forces exactly one row, same trick scheduler_
  -- settings (migration 22) already uses.
  id                  BOOLEAN NOT NULL PRIMARY KEY DEFAULT TRUE CHECK (id),
  guard_hourly_rate   NUMERIC(8, 2) CHECK (guard_hourly_rate IS NULL OR guard_hourly_rate > 0),
  manager_hourly_rate NUMERIC(8, 2) CHECK (manager_hourly_rate IS NULL OR manager_hourly_rate > 0),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO payroll_settings (id) VALUES (TRUE);

COMMENT ON TABLE payroll_settings IS
  'Singleton. One flat gross hourly wage for every guard, a separate one for the manager. NULL until the manager sets it. Used only by the personal work-log/estimated-salary feature.';

GRANT SELECT, UPDATE ON payroll_settings TO authenticated;

ALTER TABLE payroll_settings ENABLE ROW LEVEL SECURITY;

-- No guard-read policy at all -- a guard who queries this table directly
-- gets zero rows. Reading "my own rate" goes through my_hourly_rate() below.
CREATE POLICY payroll_settings_manager_all ON payroll_settings
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());

-- ----------------------------------------------------------------------------
-- my_hourly_rate(): the CALLER's own effective rate -- manager_hourly_rate
-- for a manager/admin, guard_hourly_rate otherwise. SECURITY DEFINER so a
-- guard can call this despite having no read policy on the table itself; it
-- only ever returns ONE of the two numbers, never both.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_hourly_rate()
RETURNS NUMERIC
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN public.is_manager() THEN s.manager_hourly_rate ELSE s.guard_hourly_rate END
    FROM public.payroll_settings s WHERE s.id;
$$;

REVOKE ALL ON FUNCTION public.my_hourly_rate() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_hourly_rate() TO authenticated;
