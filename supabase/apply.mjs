/**
 * Applies the migrations + seed to a Supabase project.
 *
 * Three transports, because outbound Postgres ports are blocked on some
 * networks (this one included -- 5432/6543 time out while 443 is open):
 *
 *   pg      DATABASE_URL           direct Postgres. Fastest when reachable.
 *   api     SUPABASE_ACCESS_TOKEN  Management API over HTTPS/443. Works anywhere.
 *   bundle  --bundle               writes one paste-ready .sql file, no network.
 *
 * Usage:
 *   node supabase/apply.mjs                 apply migrations + seed
 *   node supabase/apply.mjs --reset         drop everything first, then apply
 *   node supabase/apply.mjs --verify        report only, change nothing
 *   node supabase/apply.mjs --bundle        emit supabase/bundle.sql
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** Migrations are discovered, not listed, so a new file is never forgotten. */
async function migrationFiles() {
  const names = (await readdir(join(HERE, 'migrations')))
    .filter((f) => f.endsWith('.sql'))
    .sort(); // timestamp prefixes make lexical order == chronological order
  return [...names.map((n) => `migrations/${n}`), 'seed.sql'];
}

// Sealed at creation. Supabase's default privileges would otherwise hand anon
// and authenticated full CRUD on this table the moment it is created.
const LEDGER = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON schema_migrations FROM anon, authenticated;`;

const RESET_SQL = `
DROP TABLE IF EXISTS schedule_assignments, schedule_runs, weekly_guard_targets,
                     weekly_wish_preferences, weekly_submissions, roster_weeks,
                     profiles, roster_codes CASCADE;
DROP FUNCTION IF EXISTS public.is_manager()            CASCADE;
DROP FUNCTION IF EXISTS public.is_week_open(DATE)      CASCADE;
DROP FUNCTION IF EXISTS public.guard_profile_columns() CASCADE;
DROP FUNCTION IF EXISTS public.touch_updated_at()      CASCADE;
DROP FUNCTION IF EXISTS public.stamp_published_at()    CASCADE;
DROP FUNCTION IF EXISTS public.next_run_version(DATE)  CASCADE;
DROP FUNCTION IF EXISTS public.carry_in_shifts(DATE)   CASCADE;
DROP TYPE IF EXISTS shift_type, base_shift, user_role, week_status CASCADE;
`;

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

async function loadEnv() {
  const env = { ...process.env };
  const file = join(ROOT, '.env.local');
  if (existsSync(file)) {
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trimStart().startsWith('#')) {
        env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
      }
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// transports -- both expose { query(sql) -> rows, close() }
// ---------------------------------------------------------------------------

async function pgTransport(connectionString) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    application_name: 'work-orgenizer-migrate',
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  return {
    kind: 'pg',
    query: async (sql) => (await client.query(sql)).rows,
    close: () => client.end(),
  };
}

function apiTransport(projectRef, token) {
  const endpoint = `https://api.supabase.com/v1/projects/${projectRef}/database/query`;
  return {
    kind: 'api',
    query: async (sql) => {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: sql }),
      });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      if (!res.ok) {
        const msg = body?.message ?? body?.error ?? text;
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        err.status = res.status;
        throw err;
      }
      return Array.isArray(body) ? body : [];
    },
    close: async () => {},
  };
}

function projectRefFrom(env) {
  if (env.SUPABASE_PROJECT_REF) return env.SUPABASE_PROJECT_REF;
  const m = (env.VITE_SUPABASE_URL ?? '').match(/https:\/\/([a-z0-9]+)\.supabase\.co/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------

async function makeBundle() {
  const parts = [
    '-- ==========================================================================',
    '-- GENERATED -- do not edit. Produced by: node supabase/apply.mjs --bundle',
    '--',
    '-- Paste this whole file into the Supabase SQL Editor and press Run.',
    '-- It contains all migrations and the seed, in dependency order.',
    '-- ==========================================================================',
    '',
  ];
  for (const rel of await migrationFiles()) {
    parts.push(`\n-- ${'='.repeat(74)}\n-- SOURCE: supabase/${rel}\n-- ${'='.repeat(74)}\n`);
    parts.push(await readFile(join(HERE, rel), 'utf8'));
  }
  const out = join(HERE, 'bundle.sql');
  await writeFile(out, parts.join('\n'), 'utf8');
  console.log(`wrote ${out}`);
  console.log('\nPaste it into: Supabase dashboard -> SQL Editor -> New query -> Run');
}

// ---------------------------------------------------------------------------

async function verify(t) {
  // Reachability matters as much as RLS. A table with RLS off is only exposed
  // if `authenticated` can actually touch it, and a table with RLS on but zero
  // policies is deny-all -- which is the intended design for the service-role
  // tables (roster_codes writes, claim_attempts, schema_migrations). Reporting
  // those as failures would train us to ignore the warning that matters.
  const tables = await t.query(`
    SELECT c.relname AS table,
           c.relrowsecurity AS rls,
           (SELECT COUNT(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies,
           has_table_privilege('authenticated', c.oid, 'SELECT') AS can_read,
           (has_table_privilege('authenticated', c.oid, 'INSERT') OR
            has_table_privilege('authenticated', c.oid, 'UPDATE') OR
            has_table_privilege('authenticated', c.oid, 'DELETE')) AS can_write
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`);

  if (tables.length === 0) {
    console.log('No tables found in schema public.');
    return false;
  }

  const truthy = (v) => v === true || v === 't';

  console.log('table                      RLS   policies  authenticated  verdict');
  console.log('-------------------------- ----- --------  -------------  -------');
  let bad = 0;
  for (const row of tables) {
    const rls = truthy(row.rls);
    const pol = Number(row.policies);
    const read = truthy(row.can_read);
    const write = truthy(row.can_write);
    const reach = !read && !write ? 'none' : write ? 'read+write' : 'read';

    let verdict;
    if (!rls && (read || write)) {
      verdict = 'EXPOSED';
      bad++;
    } else if (!rls) {
      verdict = 'no-grants';
    } else if (pol === 0) {
      verdict = 'sealed';
    } else {
      verdict = 'protected';
    }

    console.log(
      `${row.table.padEnd(26)} ${(rls ? 'on' : 'OFF').padEnd(5)} ${String(pol).padStart(5)}     ` +
        `${reach.padEnd(13)}  ${verdict}`,
    );
  }

  const [codes] = await t.query('SELECT COUNT(*)::int AS count FROM roster_codes');
  const [fns] = await t.query(`
    SELECT COUNT(*)::int AS count FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('is_manager','is_week_open','guard_profile_columns',
                         'touch_updated_at','stamp_published_at',
                         'next_run_version','carry_in_shifts')`);
  const weeks = await t.query(
    'SELECT week_start::text, status, morning_target_slots FROM roster_weeks ORDER BY week_start');

  console.log(`\nbadge codes seeded : ${codes.count}`);
  console.log(`helper functions   : ${fns.count}/7`);
  console.log('roster weeks       :');
  for (const w of weeks) {
    console.log(`  ${w.week_start}  ${String(w.status).padEnd(10)} morning target ${w.morning_target_slots}`);
  }
  console.log(
    bad === 0
      ? '\nNo table is reachable by `authenticated` without RLS governing it.'
      : `\nWARNING: ${bad} table(s) are EXPOSED -- reachable with RLS off.`);
  return bad === 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--bundle')) return makeBundle();

  const env = await loadEnv();
  const ref = projectRefFrom(env);

  let t;
  if (env.SUPABASE_ACCESS_TOKEN && ref) {
    t = apiTransport(ref, env.SUPABASE_ACCESS_TOKEN);
    console.log(`transport: Management API over HTTPS (project ${ref})\n`);
  } else if (env.DATABASE_URL) {
    console.log('transport: direct Postgres\n');
    t = await pgTransport(env.DATABASE_URL);
  } else {
    console.error(
      '\nNo usable transport.\n\n' +
        'Either (recommended on this network, since 5432 is blocked):\n' +
        '  SUPABASE_ACCESS_TOKEN=sbp_...   in .env.local\n' +
        '  -> supabase.com/dashboard/account/tokens\n\n' +
        'Or, if Postgres ports are reachable:\n' +
        '  DATABASE_URL=postgresql://...   (Session pooler)\n\n' +
        'Or generate a paste-ready file:\n' +
        '  node supabase/apply.mjs --bundle\n');
    process.exit(1);
  }

  try {
    if (args.includes('--verify')) {
      const ok = await verify(t);
      process.exitCode = ok ? 0 : 1;
      return;
    }

    if (args.includes('--reset')) {
      process.stdout.write('resetting (dropping existing objects)          ');
      await t.query(`${RESET_SQL}\nDROP TABLE IF EXISTS schema_migrations CASCADE;`);
      console.log('ok');
    }

    await t.query(LEDGER);
    const applied = new Set(
      (await t.query('SELECT name FROM schema_migrations')).map((r) => r.name),
    );

    const files = await migrationFiles();
    let ran = 0;

    for (const rel of files) {
      // seed.sql is idempotent (ON CONFLICT DO NOTHING) and cheap, so it always
      // runs -- that lets a new roster week be added by editing the seed.
      const isSeed = rel === 'seed.sql';
      if (!isSeed && applied.has(rel)) {
        console.log(`skipping ${rel.padEnd(46)}already applied`);
        continue;
      }

      const sql = await readFile(join(HERE, rel), 'utf8');
      process.stdout.write(`applying ${rel.padEnd(46)}`);
      try {
        // One transaction per file, with the ledger write inside it: a file is
        // recorded as applied only if it actually committed.
        const ledgerWrite = isSeed
          ? ''
          : `INSERT INTO schema_migrations (name) VALUES ('${rel}')
             ON CONFLICT (name) DO NOTHING;`;
        await t.query(`BEGIN;\n${sql}\n${ledgerWrite}\nCOMMIT;`);
        console.log('ok');
        ran++;
      } catch (e) {
        console.log('FAILED');
        try {
          await t.query('ROLLBACK;');
        } catch {
          /* the server may have rolled back already */
        }
        console.error(`\n${e.message}\n`);
        process.exitCode = 1;
        return;
      }
    }

    if (ran === 0) console.log('\nnothing to do -- schema already up to date');

    console.log('');
    await verify(t);
  } finally {
    await t.close();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
