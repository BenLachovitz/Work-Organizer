/**
 * whatsapp-pin-reset -- self-service PIN recovery via a WhatsApp one-time code
 * (Meta WhatsApp Business Cloud API).
 *
 * Deployed with --no-verify-jwt, same reasoning as claim-code: a guard who
 * forgot her PIN has no session to verify. This is now the SECOND publicly
 * reachable unauthenticated write path in the system (claim-code is the
 * first) -- every branch below is written on the same "assume the caller is
 * hostile" footing that file's own docstring states, and reuses its exact
 * throttle (claim_attempts / claim_rate_ok / record_claim_attempt, migration
 * 4, widened by migration 49 to also cover the 'otp_request' action).
 *
 * The manager-only reset-pin function (migration/deploy from last session)
 * stays in place permanently as the fallback for any guard with no
 * phone_number on file yet -- this function never touches that one, and
 * never replaces it.
 *
 * Actions
 *   { action: 'otp_request', employee_code }
 *     -> looks up profiles.phone_number for a CLAIMED code, sends a 6-digit
 *        WhatsApp OTP via Meta's Cloud API, stores its SHA-256 hash.
 *   { action: 'otp_verify',  employee_code, otp }
 *     -> checks the code against the stored hash (5 wrong guesses kills it),
 *        mints a one-time verify_token on success.
 *   { action: 'otp_complete', employee_code, verify_token, new_pin }
 *     -> resets the password on the guard's EXISTING auth.users row via
 *        admin.auth.admin.updateUserById() -- the exact mechanism reset-pin
 *        already uses, duplicated here rather than cross-invoked (the two
 *        functions have incompatible auth models: a manager JWT there, a
 *        proven OTP here), then signs the guard in via the caller (handled
 *        client-side, same as claim-code's claim() -> signIn() sequence).
 *
 * Never leaks a phone number to the client, and never distinguishes "OTP
 * expired" from "too many wrong guesses" in otp_verify's response -- either
 * way the guard's only real next step is requesting a fresh code.
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
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes -- keep in sync with the Meta template's own expiry wording
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

async function sendWhatsappOtp(
  phoneNumberId: string,
  accessToken: string,
  templateName: string,
  templateLang: string,
  to: string,
  otp: string,
): Promise<boolean> {
  const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: templateLang },
        components: [{ type: 'body', parameters: [{ type: 'text', text: otp }] }],
      },
    }),
  });
  if (!res.ok) {
    // Never surface Meta's raw error body to the client -- log server-side only.
    console.error('whatsapp send failed', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
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
  // actions are, sends the WhatsApp message, stores the OTP's hash.
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

    // Business-logic prerequisites (does this guard even have a phone on
    // file?) are checked BEFORE the WhatsApp config check below -- there's no
    // reason to care whether Meta is configured for a request that was going
    // to be refused anyway, and it keeps this branch fully testable
    // regardless of whether WHATSAPP_* secrets exist yet.
    const { data: profile } = await admin
      .from('profiles')
      .select('phone_number')
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
    const phone = profile.phone_number as string | null;
    if (!phone) {
      await record(false);
      return json(
        { error: 'לא נמצא מספר טלפון עבור עובד זה. פנה למנהל המשמרת לאיפוס ידני.' },
        404,
      );
    }

    const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN');
    const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID');
    const templateName = Deno.env.get('WHATSAPP_TEMPLATE_NAME');
    const templateLang = Deno.env.get('WHATSAPP_TEMPLATE_LANG') ?? 'he';
    if (!accessToken || !phoneNumberId || !templateName) {
      await record(false);
      return json(
        { error: 'שירות שחזור הסיסמה אינו מוגדר עדיין. פנה למנהל המשמרת.', code: 'NO_WHATSAPP' },
        503,
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

    const sent = await sendWhatsappOtp(phoneNumberId, accessToken, templateName, templateLang, phone, otp);
    if (!sent) {
      await admin.from('pin_reset_otps').delete().eq('employee_code', code);
      await record(false);
      return json({ error: 'שליחת הקוד ב-WhatsApp נכשלה. נסה שוב.' }, 502);
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
