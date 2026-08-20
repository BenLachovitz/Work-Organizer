-- ============================================================================
-- Migration 47 : Per-week 12h/11h double-shift display setting
--
-- day12/night12 are, and remain, real 12-hour shifts: a guard assigned one is
-- scheduled for the full 12 hours in every hard rule, every coverage count,
-- and every kamut/rest computation, regardless of this setting. What this
-- column controls is PURELY the handover-boundary TEXT rendered next to the
-- guard's name (RosterGrid's "עד 18:45" / "מ 18:45" chip suffix, the JPEG
-- export, the guard's own "המשמרות שלי" list) -- when a manager flips a week
-- to 11, that text shortens by one hour ("עד 17:45" / "מ 19:45"), UNLESS this
-- guard is that day's ONLY real coverage of the segment the shortened hour
-- would come out of (S2 for day12, S3 for night12) -- computed client-side in
-- src/lib/shifts.ts's doubleShiftSuffix()/doubleShiftLabel(), from data
-- already in schedule_assignments, so it never risks implying an hour with
-- literally nobody there.
--
-- DEFAULT 12 (unchanged legacy text) so every existing and future week keeps
-- today's behaviour unless a manager explicitly opts a week in -- same
-- non-retroactive shape as morning_target_slots and its per-day overrides.
-- No RLS change needed: weeks_manager_write (migration 3) already governs
-- every column on this table.
-- ============================================================================

ALTER TABLE roster_weeks
  ADD COLUMN double_shift_display_hours SMALLINT NOT NULL DEFAULT 12
    CHECK (double_shift_display_hours IN (11, 12));

COMMENT ON COLUMN roster_weeks.double_shift_display_hours IS
  'Display-only. day12/night12 always count as a full 12h shift everywhere it matters (coverage, kamut, rest); this only shortens the handover-boundary TEXT shown next to the guard''s name by one hour when set to 11, and only where doing so would not misrepresent the day''s only real coverage of that hour.';
