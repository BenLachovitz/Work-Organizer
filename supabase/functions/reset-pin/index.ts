/**
 * reset-pin -- manager-triggered PIN reset for a guard who forgot theirs.
 *
 * There is no self-service "forgot PIN" flow (badge code + PIN is the whole
 * credential, and the PIN IS the literal GoTrue password for that guard's
 * synthetic `{code}@guards.local` auth user -- see claim-code). A guard who
 * forgets it cannot get back in on their own; this is the manager's way to
 * hand them a new one WITHOUT touching `profiles`, `roster_codes`, or any row
 * that references `guard_id` (schedule_assignments, weekly_submissions, etc.)
 * -- unlike delete_employee, which genuinely erases all of that. `profiles.id
 * IS auth.users.id` (same UUID, FK'd with ON DELETE CASCADE), so the only
 * thing this changes is the password on the existing auth.users row.
 *
 * Deployed WITHOUT --no-verify-jwt: every call must already carry a valid
 * Supabase session (the platform itself rejects a missing/malformed JWT
 * before this code even runs), and the code below re-checks is_manager()
 * server-side on top of that -- same two-layer pattern as generate-schedule.
 *
 * Action: { guard_id, new_pin } -> { ok: true }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same minimum claim-code enforces for a guard's own choice at registration --
// a manager-assigned temporary PIN follows the identical rule.
const PIN_MIN = 6;

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
  // Supabase injects the legacy name; newer projects may expose the secret key.
  const secret =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!url || !anon || !secret) return json({ error: 'server misconfigured' }, 500);

  // --- authorise -------------------------------------------------------------
  // Runs as the CALLER, so is_manager() applies exactly as it would for a
  // direct query -- a forged role never enters into it, since this is read
  // from the database using the caller's own JWT (same pattern as
  // generate-schedule / send-notifications' roster_published path).
  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(url, anon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: isManager, error: roleErr } = await asCaller.rpc('is_manager');
  if (roleErr) return json({ error: 'authorisation check failed' }, 500);
  if (isManager !== true) return json({ error: 'managers only' }, 403);

  // --- validate input ----------------------------------------------------------
  let payload: { guard_id?: string; new_pin?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const guardId = (payload.guard_id ?? '').trim();
  const newPin = payload.new_pin ?? '';

  if (!UUID_RE.test(guardId)) return json({ error: 'guard_id לא תקין' }, 400);
  if (newPin.length < PIN_MIN) {
    return json({ error: `הסיסמה חייבת להכיל לפחות ${PIN_MIN} תווים` }, 400);
  }

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // The target must be a real, currently-registered guard -- this only ever
  // resets a PASSWORD, never creates or revives an account (that's claim-code's
  // job, and only the guard herself can do it).
  const { data: targetProfile, error: lookupErr } = await admin
    .from('profiles')
    .select('id, display_name')
    .eq('id', guardId)
    .maybeSingle();
  if (lookupErr) return json({ error: 'server error' }, 500);
  if (!targetProfile) return json({ error: 'העובד לא נמצא' }, 404);

  const { error: updateErr } = await admin.auth.admin.updateUserById(guardId, {
    password: newPin,
  });
  if (updateErr) return json({ error: 'איפוס הסיסמה נכשל' }, 500);

  return json({ ok: true, displayName: targetProfile.display_name });
});
