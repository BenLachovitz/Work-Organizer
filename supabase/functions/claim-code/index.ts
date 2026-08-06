/**
 * claim-code -- badge registration and lookup.
 *
 * Deployed with --no-verify-jwt because the caller has no session yet: this is
 * how a guard gets one. That makes it the single publicly reachable write path
 * in the system, so every branch below is written on the assumption that the
 * caller is hostile.
 *
 * Actions
 *   { action: 'status', employee_code }        -> { exists, claimed, displayName }
 *   { action: 'claim',  employee_code, pin }   -> { ok: true }
 *
 * Security properties:
 *   - roster_codes is unreadable by anon/authenticated (RLS deny-all), so a
 *     code can only ever be probed through this throttled endpoint.
 *   - Rate limited per code (10/15min) and per IP (30/15min).
 *   - 5 failed claims disables the code until a manager re-enables it.
 *   - The auth user and its profile are created together; if the profile fails
 *     the auth user is deleted, so a half-registered guard cannot exist.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CODE_RE = /^[0-9]{6}$/;
const PIN_MIN = 6;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Trust order: Supabase sets x-forwarded-for at the edge. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  // Supabase injects the legacy name; newer projects may expose the secret key.
  const secret =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');

  if (!url || !secret) return json({ error: 'server misconfigured' }, 500);

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let payload: { action?: string; employee_code?: string; pin?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const action = payload.action;
  const code = (payload.employee_code ?? '').trim();
  const ip = clientIp(req);

  if (action !== 'status' && action !== 'claim') {
    return json({ error: 'unknown action' }, 400);
  }
  if (!CODE_RE.test(code)) {
    // Never records an attempt: a malformed code costs the DB nothing and
    // letting it consume budget would hand an attacker a cheap way to lock
    // a real guard out.
    return json({ error: 'קוד עובד חייב להיות 6 ספרות' }, 400);
  }

  // --- throttle ------------------------------------------------------------
  const { data: allowed, error: rateErr } = await admin.rpc('claim_rate_ok', {
    p_code: code,
    p_ip: ip,
  });
  if (rateErr) return json({ error: 'server error' }, 500);
  if (!allowed) {
    return json({ error: 'יותר מדי ניסיונות. נסה שוב בעוד 15 דקות.' }, 429);
  }

  const record = (ok: boolean) =>
    admin.rpc('record_claim_attempt', {
      p_code: code,
      p_ip: ip,
      p_action: action,
      p_succeeded: ok,
    });

  // --- look up the badge ---------------------------------------------------
  const { data: rosterCode } = await admin
    .from('roster_codes')
    .select('employee_code, display_name, initial_role, is_claimed, claim_enabled')
    .eq('employee_code', code)
    .maybeSingle();

  // ==========================================================================
  // status
  // ==========================================================================
  if (action === 'status') {
    await record(Boolean(rosterCode));
    if (!rosterCode) {
      return json({ exists: false, claimed: false, displayName: null });
    }
    if (!rosterCode.claim_enabled && !rosterCode.is_claimed) {
      return json(
        { error: 'הקוד נחסם עקב ניסיונות כושלים. פנה למנהל המשמרת.' },
        403,
      );
    }
    return json({
      exists: true,
      claimed: rosterCode.is_claimed,
      displayName: rosterCode.display_name,
    });
  }

  // ==========================================================================
  // claim
  // ==========================================================================
  const pin = payload.pin ?? '';
  if (pin.length < PIN_MIN) {
    return json({ error: `הסיסמה חייבת להכיל לפחות ${PIN_MIN} תווים` }, 400);
  }

  if (!rosterCode) {
    await record(false);
    return json({ error: 'הקוד לא רשום במערכת' }, 404);
  }
  if (!rosterCode.claim_enabled) {
    await record(false);
    return json({ error: 'הקוד חסום. פנה למנהל המשמרת.' }, 403);
  }
  if (rosterCode.is_claimed) {
    await record(false);
    // Deliberately not "wrong password" -- the account exists, so the correct
    // next step is the normal sign-in screen, not another claim.
    return json({ error: 'הקוד כבר רשום. התחבר עם הסיסמה שלך.' }, 409);
  }

  const email = `${code}@guards.local`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: pin,
    email_confirm: true,
    user_metadata: { employee_code: code, display_name: rosterCode.display_name },
  });

  if (createErr || !created?.user) {
    await record(false);
    const already = /already|exists|registered/i.test(createErr?.message ?? '');
    return json(
      { error: already ? 'הקוד כבר רשום. התחבר עם הסיסמה שלך.' : 'יצירת המשתמש נכשלה' },
      already ? 409 : 500,
    );
  }

  const userId = created.user.id;

  const { error: profileErr } = await admin.from('profiles').insert({
    id: userId,
    employee_code: code,
    display_name: rosterCode.display_name,
    role: rosterCode.initial_role,
    is_active: true,
  });

  if (profileErr) {
    // Roll back: an auth user with no profile can sign in but has no role,
    // and would permanently occupy the badge code.
    await admin.auth.admin.deleteUser(userId);
    await record(false);
    return json({ error: 'יצירת הפרופיל נכשלה' }, 500);
  }

  const { error: markErr } = await admin
    .from('roster_codes')
    .update({ is_claimed: true, claimed_at: new Date().toISOString() })
    .eq('employee_code', code)
    .eq('is_claimed', false); // guards against two simultaneous claims

  if (markErr) {
    await admin.from('profiles').delete().eq('id', userId);
    await admin.auth.admin.deleteUser(userId);
    await record(false);
    return json({ error: 'רישום הקוד נכשל' }, 500);
  }

  await record(true);
  return json({ ok: true, displayName: rosterCode.display_name });
});
