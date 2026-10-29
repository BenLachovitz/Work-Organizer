/**
 * One-time backfill: seeds work_log_entries for every guard's PUBLISHED
 * roster assignments in the current calendar month, so the owner can see
 * the new personal work-log/estimated-salary feature populated immediately
 * after deploying it -- instead of waiting for each guard to open /worklog
 * themselves (useWorkLogWeek only seeds lazily, one guard/week at a time).
 *
 * Deliberately PUBLISHED-only (schedule_runs.is_published), never a draft or
 * merely 'generated' week -- an unpublished roster is not a real commitment
 * to who actually worked.
 *
 * Idempotent: uses the same ON CONFLICT (source_assignment_id) the app's own
 * lazy seed relies on (work_log_one_per_assignment, migration 58's PARTIAL
 * unique index -- the WHERE clause here must be restated for Postgres to
 * accept it as the conflict target), so running this twice, or after a guard
 * has already opened /worklog for some of these weeks, never duplicates or
 * overwrites anything a guard already has.
 *
 * The nominal shift-hours VALUES table below mirrors src/lib/shifts.ts's
 * SHIFTS record by hand (same reasoning as solver/scheduler.py mirroring it)
 * -- this is a one-time script, not re-run on every deploy, so a future
 * change to a shift's clock window will not silently desync it; just update
 * both if that ever happens.
 *
 * Run manually, once, after Phases 1-5 are deployed:
 *   node supabase/scripts/backfill-worklog-month.mjs
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const env = {};
for (const line of (await readFile(join(ROOT, '.env.local'), 'utf8')).split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2];
}
const REF = env.VITE_SUPABASE_URL.match(/https:\/\/([a-z0-9]+)\./)[1];

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
  return body;
}

// "Today" in Asia/Jerusalem, the same convention src/lib/dates.ts's
// todayInIsrael() uses -- the month this backfills is Israel's current one,
// not whatever month the machine running this script happens to be in.
const todayIsrael = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
const [y, m] = todayIsrael.split('-').map(Number);
const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

console.log(`Backfilling work_log_entries for ${monthStart}..${monthEnd} (published rosters only)\n`);

const result = await sql(`
  WITH shift_hours (shift, start_h, end_h) AS (
    VALUES
      ('morning'::shift_type,         6.75, 14.75),
      ('afternoon'::shift_type,      14.75, 22.75),
      ('night'::shift_type,          22.75, 30.75),
      ('day12'::shift_type,           6.75, 18.75),
      ('night12'::shift_type,        18.75, 30.75),
      ('afternoon_early'::shift_type, 14.75, 18.75),
      ('afternoon_late'::shift_type,  18.75, 22.75),
      ('kippur_day1'::shift_type,     14.75, 30.75),
      ('kippur_day2'::shift_type,      6.75, 22.75)
  ),
  target AS (
    SELECT a.id AS assignment_id, a.guard_id, a.target_date, a.shift,
           (a.target_date::timestamp AT TIME ZONE 'Asia/Jerusalem')
             + (sh.start_h || ' hours')::interval AS scheduled_start,
           (a.target_date::timestamp AT TIME ZONE 'Asia/Jerusalem')
             + (sh.end_h   || ' hours')::interval AS scheduled_end
      FROM schedule_assignments a
      JOIN schedule_runs r ON r.id = a.run_id
      JOIN shift_hours sh ON sh.shift = a.shift
     WHERE r.is_published
       AND a.guard_id IS NOT NULL
       AND a.target_date BETWEEN '${monthStart}' AND '${monthEnd}'
  ),
  inserted AS (
    INSERT INTO work_log_entries
      (guard_id, target_date, shift, source, source_assignment_id,
       scheduled_start, scheduled_end, actual_start, actual_end)
    SELECT guard_id, target_date, shift, 'roster', assignment_id,
           scheduled_start, scheduled_end, scheduled_start, scheduled_end
      FROM target
    ON CONFLICT (source_assignment_id) WHERE source_assignment_id IS NOT NULL DO NOTHING
    RETURNING source_assignment_id
  )
  SELECT p.display_name,
         COUNT(t.assignment_id)                                    AS published_assignments,
         COUNT(i.source_assignment_id)                             AS newly_inserted
    FROM target t
    JOIN profiles p ON p.id = t.guard_id
    LEFT JOIN inserted i ON i.source_assignment_id = t.assignment_id
   GROUP BY p.display_name
   ORDER BY p.display_name;
`);

const rows = result?.[0]?.rows ?? result?.result ?? result;
console.log('guard                published  newly inserted');
for (const row of Array.isArray(rows) ? rows : []) {
  console.log(
    `${String(row.display_name).padEnd(20)} ${String(row.published_assignments).padStart(9)}  ${String(row.newly_inserted).padStart(14)}`,
  );
}
console.log('\nDone. Already-seeded or guard-edited entries were left untouched.');
