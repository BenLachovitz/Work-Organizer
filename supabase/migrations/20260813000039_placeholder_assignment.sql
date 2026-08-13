-- ============================================================================
-- Migration 39 : Placeholder (guard-less) assignment rows
--
-- Migration 38 (§12.9) let a manager annotate a REAL assignment with free
-- text. It doesn't cover the case where the annotation isn't about any one
-- guard's real shift at all -- e.g. "Yam is alone in the morning until
-- 10:45, then Shely joins" is a fact about the MORNING segment as a whole,
-- not a second real assignment for Shely. She may already be genuinely
-- assigned elsewhere that day, and adding her again would be a real
-- double-booking -- the one_shift_per_guard_per_day index and the referee's
-- H3 check are RIGHT to refuse that, because as far as the data model is
-- concerned it would be exactly that.
--
-- schedule_assignments.guard_id becomes nullable: a NULL-guard row is a
-- placeholder that exists purely to carry note_before/note_after text on a
-- cell, with no real person behind it. Both existing UNIQUE constraints
-- already treat NULL as distinct from any other value (standard SQL), so
-- nothing else about them needs to change -- a run/day/shift can hold any
-- number of placeholder rows alongside its real ones, with no collision.
--
-- A placeholder is checked the other direction instead: it must carry at
-- least one note, or it is just a blank row with no purpose. The client
-- (RosterEditor.tsx) already drops an emptied-out placeholder before saving,
-- so this is a defence-in-depth backstop, not the primary UX.
-- ============================================================================

ALTER TABLE schedule_assignments ALTER COLUMN guard_id DROP NOT NULL;

ALTER TABLE schedule_assignments
  ADD CONSTRAINT placeholder_needs_a_note
  CHECK (guard_id IS NOT NULL OR note_before IS NOT NULL OR note_after IS NOT NULL);

COMMENT ON COLUMN schedule_assignments.guard_id IS
  'NULL means this row is a placeholder -- a note-only cell annotation with no real guard behind it (v2.11 sec.12.9/migration 39). Never produced by the solver; manual edits only. Excluded from coverage counts and from every hard-rule check (H1/H3/H4/H5/H6/H7) -- see RosterEditor.tsx and RosterGrid.tsx.';
