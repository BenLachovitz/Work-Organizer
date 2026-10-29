-- ============================================================================
-- Migration 62 : Payroll rate HISTORY, replacing the single-value settings
--
-- payroll_settings (migration 61) held one CURRENT rate per role -- but
-- updating it would retroactively change every past month's already-
-- computed estimate too, which is exactly what the owner does not want
-- (e.g. a raise effective 1 November must never change October's numbers).
-- Nothing has ever been written to payroll_settings in production (both
-- rates are still NULL), so this replaces it outright rather than
-- migrating data that does not exist.
--
-- payroll_rates is append-only: "from this date onward, the rate was X".
-- Changing the rate is an INSERT of a new row, never an UPDATE of an old
-- one -- see PayrollRateSettings.tsx. The rate in effect for any given day
-- is the latest row whose effective_from is on or before it (src/lib/
-- payroll.ts's rateForDate(), mirrored here by my_hourly_rate_history()).
-- ============================================================================

DROP FUNCTION IF EXISTS public.my_hourly_rate();
DROP TABLE IF EXISTS payroll_settings;

CREATE TYPE payroll_role AS ENUM ('guard', 'manager');

CREATE TABLE payroll_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role           payroll_role NOT NULL,
  hourly_rate    NUMERIC(8, 2) NOT NULL CHECK (hourly_rate > 0),
  effective_from DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One rate change per role per day -- a second change on the same day
  -- would be ambiguous about which one actually applies.
  UNIQUE (role, effective_from)
);

COMMENT ON TABLE payroll_rates IS
  'Append-only history of the flat gross hourly wage per role (guard/manager). A row never changes once written -- a new rate is a new row with its own effective_from, so a later change can never recalculate a month that already passed. Used only by the personal work-log/estimated-salary feature.';

-- Append-only by convention (no UPDATE grant): correcting a mis-entered row
-- is a DELETE + a fresh INSERT, never an in-place edit of history.
GRANT SELECT, INSERT, DELETE ON payroll_rates TO authenticated;

ALTER TABLE payroll_rates ENABLE ROW LEVEL SECURITY;

-- No guard-read policy at all -- a guard who queries this table directly
-- gets zero rows, for both roles. Reading "my own rate as of date X" goes
-- through my_hourly_rate_history() below.
CREATE POLICY payroll_rates_manager_all ON payroll_rates
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());

-- ----------------------------------------------------------------------------
-- my_hourly_rate_history(): the CALLER's own full rate history -- every
-- 'manager' row for a manager/admin, every 'guard' row otherwise. SECURITY
-- DEFINER so a guard can call this despite having no read policy on the
-- table itself; it only ever returns ONE role's rows, never the other's.
-- The client (src/lib/payroll.ts's rateForDate()) resolves "the rate on
-- date X" from this list -- there is no date-scoped SQL function, so a
-- monthly rollup spanning a rate change only needs one round trip.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_hourly_rate_history()
RETURNS TABLE (effective_from DATE, hourly_rate NUMERIC)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT r.effective_from, r.hourly_rate
    FROM public.payroll_rates r
   WHERE r.role = (CASE WHEN public.is_manager() THEN 'manager' ELSE 'guard' END)::payroll_role
   ORDER BY r.effective_from;
$$;

REVOKE ALL ON FUNCTION public.my_hourly_rate_history() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.my_hourly_rate_history() TO authenticated;
