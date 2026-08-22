/**
 * request-pin-reset -- self-service PIN recovery via a one-time code
 * delivered as a PUSH NOTIFICATION (migration 50).
 *
 * Replaces the WhatsApp-based whatsapp-pin-reset (migrations 48-49, last
 * session) before it ever went live: the intended delivery channel needed a
 * Meta WhatsApp Business Account, which needs a Meta Business Portfolio,
 * which Ben's Meta account cannot currently create (an Ads-billing dispute
 * restricts it, and there is no way to attach WhatsApp to an app without a
 * Business Portfolio -- confirmed, not a UI quirk to route around). Ben's
 * call: deliver the OTP through this app's OWN already-working push
 * notification system instead (send-notifications, migrations 40-45) --
 * no new external account, no new dependency, reuses infrastructure already
 * live in production. phone_number, which existed only to feed the Meta
 * call, is reverted (migration 50) -- nothing else ever used it.
 *
 * Deployed with --no-verify-jwt, same reasoning as claim-code: a guard who
 * forgot her PIN has no session to verify. The one real trade-off versus
 * WhatsApp: delivery needs an EXISTING push_subscriptions row for this
 * guard, which itself needs a prior login on that same device with
 * notifications enabled -- a guard with no subscription anywhere, or on an
 * unfamiliar device, gets a clean error routing her to the manager's
 * reset-pin fallback instead, same shape as the old "no phone on file" case.
 *
 * Actions
 *   { action: 'otp_request', employee_code }
 *     -> looks up the guard's push subscription(s), sends a 6-digit OTP via
 *        send-notifications' pin_reset_otp type, stores its SHA-256 hash.
 *   { action: 'otp_verify',  employee_code, otp }
 *     -> checks the code against the stored hash (5 wrong guesses kills it),
 *        mints a one-time verify_token on success.
 *   { action: 'otp_complete', employee_code, verify_token, new_pin }
 *     -> resets the password on the guard's EXISTING auth.users row via
 *        admin.auth.admin.updateUserById() -- the same call reset-pin
 *        already makes, duplicated here rather than cross-invoked (the two
 *        functions have incompatible auth models). Unchanged from the
 *        WhatsApp-era design -- otp_verify/otp_complete never cared how the
 *        code was delivered.
 *
 * Never distinguishes "OTP expired" from "too many wrong guesses" in
 * otp_verify's response -- either way the guard's only real next step is
 * requesting a fresh code.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CODE_RE = /^[0-9]{6}$/;
const OTP_RE = /^[0-9]{6}$/;
const PIN_MIN = 6;
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Trust order: Supabase sets x-forwarded-for at the edge. Mirrors claim-code. */
function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return req.headers.get('cf-connecting-ip') ?? 'unknown';
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** crypto.getRandomValues, not Math.random() -- this code guards a real credential reset. */
function generateOtp(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0]! % 900000));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const secret =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!url || !secret) return json({ error: 'server misconfigured' }, 500);

  const admin = createClient(url, secret, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let payload: {
    action?: string;
    employee_code?: string;
    otp?: string;
    verify_token?: string;
    new_pin?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  const action = payload.action;
  const code = (payload.employee_code ?? '').trim();

  if (action !== 'otp_request' && action !== 'otp_verify' && action !== 'otp_complete') {
    return json({ error: 'unknown action' }, 400);
  }
  if (!CODE_RE.test(code)) {
    return json({ error: 'קוד עובד חייב להיות 6 ספרות' }, 400);
  }

  // ==========================================================================
  // otp_request -- looks up profiles (not roster_codes: only a CLAIMED guard
  // has a password to reset), rate-limited the same way claim-code's own
  // actions are, delivers the OTP via a push notification, stores its hash.
  // ==========================================================================
  if (action === 'otp_request') {
    const ip = clientIp(req);
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
        p_action: 'otp_request',
        p_succeeded: ok,
      });

    const { data: profile } = await admin
      .from('profiles')
      .select('id')
      .eq('employee_code', code)
      .maybeSingle();

    if (!profile) {
      await record(false);
      // The UI never reaches this action for an unclaimed/unknown code (it
      // only shows the forgot-PIN button once lookupCode already confirmed
      // claimed=true), so a plain error here leaks nothing that action
      // hasn't already told the guard.
      return json({ error: 'הקוד אינו רשום או טרם נרשם. פנה למנהל המשמרת.' }, 404);
    }
    const guardId = profile.id as string;

    // Delivery needs an EXISTING push subscription -- checked here (rather
    // than only discovered inside send-notifications) so the guard gets a
    // specific, actionable error instead of a false "ok" that never arrives.
    const { count: subCount } = await admin
      .from('push_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('guard_id', guardId);

    if (!subCount) {
      await record(false);
      return json(
        {
          error:
            'לא ניתן לשלוח קוד אימות למכשיר זה - ההתראות אינן מופעלות. פנה למנהל המשמרת לאיפוס ידני.',
        },
        404,
      );
    }

    const otp = generateOtp();
    const otpHash = await sha256Hex(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

    // At most one live OTP per code -- a fresh request invalidates any prior one.
    await admin.from('pin_reset_otps').delete().eq('employee_code', code);
    const { error: insertErr } = await admin.from('pin_reset_otps').insert({
      employee_code: code,
      otp_hash: otpHash,
      expires_at: expiresAt,
    });
    if (insertErr) {
      await record(false);
      return json({ error: 'שגיאת שרת' }, 500);
    }

    // Server-to-server call into send-notifications, the exact same
    // cron-secret mechanism notification_tick already uses (pg_net calling
    // the same URL/secret pair from Postgres instead of from here).
    const { data: secrets } = await admin
      .from('notification_secrets')
      .select('notify_url, cron_secret')
      .single();

    let sent = 0;
    if (secrets?.notify_url && secrets?.cron_secret) {
      try {
        const res = await fetch(secrets.notify_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': secrets.cron_secret },
          body: JSON.stringify({ type: 'pin_reset_otp', guard_id: guardId, otp }),
        });
        const body = await res.json().catch(() => null);
        sent = res.ok ? ((body?.sent as number | undefined) ?? 0) : 0;
      } catch {
        sent = 0;
      }
    }

    if (sent < 1) {
      // Nothing actually delivered -- don't leave a dead OTP a guard could
      // never legitimately use, and don't tell her it worked when it didn't.
      await admin.from('pin_reset_otps').delete().eq('employee_code', code);
      await record(false);
      return json(
        {
          error:
            'שליחת קוד האימות נכשלה. ודא שההתראות פעילות במכשיר זה, או פנה למנהל המשמרת לאיפוס ידני.',
        },
        502,
      );
    }

    await record(true);
    return json({ ok: true });
  }

  // ==========================================================================
  // otp_verify -- 5 wrong guesses kills the code; correct guess mints a
  // one-time verify_token consumed by otp_complete.
  // ==========================================================================
  if (action === 'otp_verify') {
    const otp = payload.otp ?? '';
    if (!OTP_RE.test(otp)) return json({ error: 'קוד לא תקין' }, 400);

    const { data: row } = await admin
      .from('pin_reset_otps')
      .select('id, otp_hash, attempts, expires_at')
      .eq('employee_code', code)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const expired = !row || new Date(row.expires_at as string) <= new Date();
    const lockedOut = row && (row.attempts as number) >= MAX_ATTEMPTS;
    if (expired || lockedOut) {
      return json({ error: 'הקוד פג תוקף. שלח קוד חדש.' }, 400);
    }

    const otpHash = await sha256Hex(otp);
    if (otpHash !== row.otp_hash) {
      await admin
        .from('pin_reset_otps')
        .update({ attempts: (row.attempts as number) + 1 })
        .eq('id', row.id);
      return json({ error: 'קוד שגוי' }, 400);
    }

    const verifyToken = crypto.randomUUID();
    const { error: updateErr } = await admin
      .from('pin_reset_otps')
      .update({ verified_at: new Date().toISOString(), verify_token: verifyToken })
      .eq('id', row.id);
    if (updateErr) return json({ error: 'שגיאת שרת' }, 500);

    return json({ ok: true, verify_token: verifyToken });
  }

  // ==========================================================================
  // otp_complete -- requires a verify_token from a successful otp_verify,
  // resets the password on the guard's EXISTING auth.users row (same call
  // reset-pin already makes), then consumes the OTP row.
  // ==========================================================================
  const verifyToken = payload.verify_token ?? '';
  const newPin = payload.new_pin ?? '';
  if (!verifyToken) return json({ error: 'אימות חסר' }, 400);
  if (newPin.length < PIN_MIN) {
    return json({ error: `הסיסמה חייבת להכיל לפחות ${PIN_MIN} תווים` }, 400);
  }

  const { data: row } = await admin
    .from('pin_reset_otps')
    .select('id, verified_at, verify_token, expires_at')
    .eq('employee_code', code)
    .eq('verify_token', verifyToken)
    .maybeSingle();

  const expired = !row || new Date(row.expires_at as string) <= new Date();
  if (expired || !row.verified_at) {
    return json({ error: 'האימות פג תוקף. התחל שוב.' }, 400);
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('id, display_name')
    .eq('employee_code', code)
    .maybeSingle();
  if (!profile) return json({ error: 'העובד לא נמצא' }, 404);

  const { error: pwErr } = await admin.auth.admin.updateUserById(profile.id as string, {
    password: newPin,
  });
  if (pwErr) return json({ error: 'איפוס הסיסמה נכשל' }, 500);

  await admin.from('pin_reset_otps').delete().eq('id', row.id);

  return json({ ok: true, displayName: profile.display_name });
});
