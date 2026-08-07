-- ============================================================================
-- Migration 15 : Push roster changes to guards' phones
--
-- Until now a guard saw an edit only when they next opened the app. If the
-- manager pulled somebody off a shift an hour before it started, the app was no
-- help -- they still had to phone. That is the gap this closes.
--
-- Three tables are published, and each covers a different way a roster can
-- change:
--
--   schedule_assignments -- a swap or removal inside a live roster
--   schedule_runs        -- publish / unpublish
--   roster_weeks         -- the week's status, which also moves when a
--                           published run is DELETED
--
-- roster_weeks matters more than it looks. Postgres cannot evaluate RLS against
-- a deleted row's contents, so a DELETE on schedule_runs may never reach a
-- guard. Deleting a published roster also flips roster_weeks.status away from
-- 'published', and that UPDATE is on a table every authenticated user may read
-- -- so it always arrives. It is the reliable signal that a roster vanished.
--
-- REPLICA IDENTITY FULL makes UPDATE and DELETE events carry the old row, which
-- Realtime needs to decide who was allowed to see it.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['schedule_assignments', 'schedule_runs', 'roster_weeks']
  LOOP
    -- ALTER PUBLICATION ... ADD TABLE errors if the table is already a member,
    -- so this has to be conditional to stay re-runnable.
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

-- Realtime evaluates the SELECT policies already in place, so a guard is pushed
-- only what they could have fetched: the published roster for the current or a
-- future week, never a draft and never the archive. No new policy is needed --
-- and adding one here would be a second place for the archive rule to drift.
