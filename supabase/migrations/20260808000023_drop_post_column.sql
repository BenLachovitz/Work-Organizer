-- ============================================================================
-- Migration 23 : Drop schedule_assignments.post
--
-- Manual post assignment (סריקה/בוטקה/בקרה/שמירה) was dropped at Ben's
-- request early in the project (spec §13 open item 7) -- but only the
-- FEATURE was dropped; the column was left in the schema, nullable and
-- never written. No client code, hook, or Edge Function has ever read or
-- written it (confirmed by grep across src/ and supabase/functions/), and
-- a live check found zero non-null rows across every assignment the system
-- has ever generated. A column nothing writes and nothing reads is not
-- "reserved for later" the way weekly_wish_preferences.strength genuinely
-- is (that one has a stated future feature and a real default in active
-- use) -- it is just schema weight left over from a decision that already
-- happened. Dropping it.
-- ============================================================================

ALTER TABLE schedule_assignments DROP COLUMN post;
