-- ============================================================================
-- Migration 65 : Travel allowance (נסיעות) rate history
--
-- Same append-only shape as payroll_rates (migration 62): "from this date
-- onward, the daily travel allowance was X", changed by inserting a new row
-- rather than editing an old one, so a later change never recalculates a
-- month that already passed. Calibrated against the owner's real August
-- 2026 payslip: code 066 "נסיעות", ₪9.00 rate, the separate "נ.שרון" figure
-- of ₪16.00 is itself the real per-day travel rate for that route/region
-- (confirmed by the owner, not derived) -- ₪144.00 paid that month / ₪16.00
-- = 9 days, consistent with a flat per-worked-day allowance.
--
-- Unlike payroll_rates, this is NOT split by role -- one flat rate for
-- every guard and the manager alike, per the owner's own description. That
-- also means there is no "which role's rate" to hide, so -- unlike
-- payroll_rates, which has no guard read policy at all and goes through
-- my_hourly_rate_history() -- any authenticated guard can read this table
-- directly; only a manager can add or remove a rate.
-- ============================================================================

CREATE TABLE travel_rates (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_rate     NUMERIC(8, 2) NOT NULL CHECK (daily_rate >= 0),
  effective_from DATE NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE travel_rates IS
  'Append-only history of the flat travel allowance (נסיעות) paid per worked day, the same for every guard and the manager. A row never changes once written -- a new rate is a new row with its own effective_from. Used only by the personal work-log/estimated-salary feature, alongside payroll_rates.';

GRANT SELECT, INSERT, DELETE ON travel_rates TO authenticated;

ALTER TABLE travel_rates ENABLE ROW LEVEL SECURITY;

-- Open read for every authenticated guard -- there is nothing role-specific
-- to hide here, unlike the hourly wage.
CREATE POLICY travel_rates_read ON travel_rates
  FOR SELECT TO authenticated
  USING (true);

CREATE POLICY travel_rates_manager_write ON travel_rates
  FOR ALL TO authenticated
  USING (is_manager())
  WITH CHECK (is_manager());
