/**
 * generate-schedule -- manager-gated proxy to the CP-SAT solver service.
 *
 * Deliberately thin. It does exactly two things the browser cannot:
 *   1. holds SOLVER_SECRET, so the shared token never ships in a phone bundle
 *   2. re-checks that the caller is really a manager, server-side
 *
 * It does NOT gather data, compute effective_kamut, verify the result or write
 * the roster. All of that lives in src/hooks/useGenerateSchedule.ts, reusing
 * validate.ts and mockSolver.ts. Reimplementing them here in Deno would create
 * a third copy of rules that already exist twice (TypeScript and Python), and
 * the whole point of the twin-referee design is that there are exactly two
 * implementations kept in step by shared fixtures.
 *
 * Every write the client makes afterwards is still governed by RLS, which does
 * not trust the client's opinion of its own role.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const anon = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  const solverUrl = Deno.env.get('SOLVER_URL');
  const solverSecret = Deno.env.get('SOLVER_SECRET');

  if (!url || !anon) return json({ error: 'server misconfigured' }, 500);
  if (!solverUrl || !solverSecret) {
    // Explicit, so the client can fall back to the in-browser solver rather
    // than guessing why generation failed.
    return json({ error: 'solver not configured', code: 'NO_SOLVER' }, 503);
  }

  // --- authorise ------------------------------------------------------------
  // Runs as the CALLER, so profiles RLS and is_manager() apply exactly as they
  // would for a direct query. A forged role in the request body is irrelevant:
  // the role is read from the database using the caller's own JWT.
  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: isManager, error: roleErr } = await asCaller.rpc('is_manager');
  if (roleErr) return json({ error: 'authorisation check failed' }, 500);
  if (isManager !== true) return json({ error: 'managers only' }, 403);

  // --- forward to the solver ------------------------------------------------
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  try {
    const res = await fetch(`${solverUrl.replace(/\/$/, '')}/solve`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${solverSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      // Render's free tier cold-starts in roughly 50s; allow for it rather
      // than failing a request that was going to succeed.
      signal: AbortSignal.timeout(90_000),
    });

    const text = await res.text();
    if (!res.ok) {
      return json({ error: 'solver rejected the request', detail: text.slice(0, 500) }, 502);
    }
    return new Response(text, {
      status: 200,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ error: 'solver unreachable', code: 'SOLVER_DOWN', detail: msg }, 504);
  }
});
