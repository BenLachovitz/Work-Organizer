-- ============================================================================
-- Migration 18 : Push guard submissions to the manager's screen live
--
-- Migration 15 pushed roster CHANGES to guards. This is the other direction:
-- a guard submitting availability (or a note) previously updated nothing on
-- the manager's dashboard until they reloaded the page -- the query was
-- correct, it just never re-ran.
--
-- Same two tables a submission touches: weekly_submissions (the note, and the
-- row that distinguishes "submitted empty" from "never submitted", spec 3.4)
-- and weekly_wish_preferences (the slots themselves).
--
-- REPLICA IDENTITY FULL matters more here than it did in migration 15:
-- save_week_preferences DELETEs every preference row before re-inserting the
-- new set (spec's atomic-replace design), and with the default replica
-- identity a DELETE only carries the primary key -- not guard_id -- so
-- Realtime cannot evaluate the `guard_id = auth.uid() OR is_manager()` policy
-- against it and drops the event. FULL carries the whole old row, so the
-- manager's subscription actually receives it.
-- ============================================================================

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['weekly_submissions', 'weekly_wish_preferences']
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime'
         AND schemaname = 'public'
         AND tablename = v_table
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', v_table);
    END IF;

    EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', v_table);
  END LOOP;
END $$;

-- Realtime evaluates the same SELECT policies already in place (subs_read,
-- prefs_read) -- a guard is pushed only their own row, a manager everyone's.
-- No new policy needed.
