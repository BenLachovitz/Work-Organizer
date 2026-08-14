/**
 * webauthn -- app-scoped WebAuthn passkey registration and sign-in.
 *
 * Replaces v2.16.0's use of Supabase Auth's native, experimental Passkey API.
 * That API only issues true, discoverable, OS-synced passkeys (shown in the
 * phone's system "Passwords & passkeys" list, eligible to sync to the
 * guard's Google/Apple account) -- real-device testing confirmed that's not
 * what's wanted here. This function runs the ceremony itself via
 * @simplewebauthn/server with residentKey: 'discouraged', so credentials are
 * scoped to this app and this device only, and stores the result in
 * webauthn_credentials (migration 46) instead of GoTrue's own passkey store.
 *
 * Deployed with --no-verify-jwt: auth-options/auth-verify have no session by
 * definition (that's what they're establishing), so this function does its
 * own auth checks per action rather than relying on the platform gate.
 *
 * Actions
 *   { action: 'register-options' }                      (needs caller JWT)
 *   { action: 'register-verify', credential }            (needs caller JWT)
 *   { action: 'auth-options', guard_id }                 (no session)
 *   { action: 'auth-verify',   guard_id, credential }    (no session)
 *
 * register-* resolve the caller's own guard_id from their own JWT (asCaller
 * + getUser(token) -- the same pattern send-notifications uses for
 * guard_submitted/guard_cancelled, and the same lesson v2.15.1 had to learn
 * the hard way: getUser() needs the token passed explicitly, it does not
 * pick up the global Authorization header the way .rpc()/.from() do).
 *
 * auth-* accept a client-supplied guard_id as a plain HINT for which
 * credential to challenge -- never a trust boundary. The actual
 * authorization is the cryptographic signature verified against that
 * specific guard's stored public key; a forged guard_id does nothing
 * without the matching physical authenticator.
 *
 * A successful auth-verify mints a real Supabase session without a password:
 * admin.generateLink({ type: 'magiclink' }) does NOT send any mail, it just
 * returns a token; exchanging that token via verifyOtp() on a plain
 * anon-key client immediately, server-side, produces a real { session }.
 * Only its access/refresh tokens are returned to the browser, which installs
 * them with supabase.auth.setSession().
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from 'jsr:@simplewebauthn/server@13';
import { isoUint8Array } from 'jsr:@simplewebauthn/server@13/helpers';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Never trust the Origin header blindly -- only these two exact origins are
 * ever accepted, and each maps to its own RP ID. A credential registered
 * under one will not verify under the other (correct, expected WebAuthn
 * behaviour -- they're different relying parties), which is what makes the
 * "localhost" entry a safe, disposable dev-testing lane rather than a way to
 * touch production credentials from a dev machine.
 */
const RP_CONFIG: Record<string, { rpId: string; rpName: string }> = {
  'https://work-organizer-iota.vercel.app': { rpId: 'work-organizer-iota.vercel.app', rpName: 'Work-Organizer' },
  'http://localhost:5173': { rpId: 'localhost', rpName: 'Work-Organizer (dev)' },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function resolveRp(req: Request): { rpId: string; rpName: string; origin: string } | null {
  const origin = req.headers.get('origin') ?? '';
  const cfg = RP_CONFIG[origin];
  return cfg ? { ...cfg, origin } : null;
}

/** BYTEA over PostgREST is hex-encoded, prefixed with \x, both ways. */
function bytesToPgHex(bytes: Uint8Array): string {
  return '\\x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function pgHexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^\\x/, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  if (!url || !serviceKey || !anonKey) return json({ error: 'server misconfigured' }, 500);

  const rp = resolveRp(req);
  if (!rp) return json({ error: 'unsupported origin' }, 403);

  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  let payload: { action?: string; guard_id?: string; credential?: unknown };
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const action = payload.action;

  /** register-options/register-verify only: resolves the caller's own id
   *  from their own JWT. Never trusts a client-supplied guard_id. */
  async function callerGuardId(): Promise<string | null> {
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    if (!token) return null;
    const asCaller = createClient(url!, anonKey!, { auth: { persistSession: false } });
    try {
      const { data, error } = await asCaller.auth.getUser(token);
      if (error || !data.user) return null;
      return data.user.id;
    } catch {
      return null;
    }
  }

  async function issueChallenge(guardId: string, purpose: 'register' | 'auth', challenge: string) {
    await admin.from('webauthn_challenges').delete().eq('guard_id', guardId).eq('purpose', purpose);
    await admin.from('webauthn_challenges').insert({
      guard_id: guardId,
      purpose,
      challenge,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS).toISOString(),
    });
  }

  /** Consumes (deletes) the matching challenge and returns it if still
   *  valid, null otherwise -- single-use by construction. */
  async function consumeChallenge(guardId: string, purpose: 'register' | 'auth'): Promise<string | null> {
    const { data } = await admin
      .from('webauthn_challenges')
      .delete()
      .eq('guard_id', guardId)
      .eq('purpose', purpose)
      .select('challenge, expires_at')
      .maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.challenge;
  }

  // ==========================================================================
  if (action === 'register-options') {
    const guardId = await callerGuardId();
    if (!guardId) return json({ error: 'unauthorized' }, 401);

    const { data: profile } = await admin
      .from('profiles')
      .select('employee_code, display_name')
      .eq('id', guardId)
      .single();
    if (!profile) return json({ error: 'profile not found' }, 404);

    const { data: existing } = await admin
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('guard_id', guardId);

    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpId,
      userID: isoUint8Array.fromUTF8String(guardId),
      userName: profile.employee_code,
      userDisplayName: profile.display_name,
      attestationType: 'none',
      excludeCredentials: (existing ?? []).map((c) => ({
        id: c.credential_id,
        transports: c.transports ?? undefined,
      })),
      authenticatorSelection: {
        residentKey: 'discouraged',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
    });

    await issueChallenge(guardId, 'register', options.challenge);
    return json({ options });
  }

  // ==========================================================================
  if (action === 'register-verify') {
    const guardId = await callerGuardId();
    if (!guardId) return json({ error: 'unauthorized' }, 401);

    const expectedChallenge = await consumeChallenge(guardId, 'register');
    if (!expectedChallenge) return json({ error: 'האתגר פג תוקף. נסה שוב.' }, 400);

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        // deno-lint-ignore no-explicit-any
        response: payload.credential as any,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
      });
    } catch {
      return json({ error: 'אימות ההרשמה נכשל' }, 400);
    }
    if (!verification.verified || !verification.registrationInfo) {
      return json({ error: 'אימות ההרשמה נכשל' }, 400);
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const { error: insertErr } = await admin.from('webauthn_credentials').insert({
      guard_id: guardId,
      credential_id: credential.id,
      public_key: bytesToPgHex(credential.publicKey),
      counter: credential.counter,
      device_type: credentialDeviceType,
      backed_up: credentialBackedUp,
      transports: credential.transports ?? null,
    });
    if (insertErr) return json({ error: 'שמירת האימות הביומטרי נכשלה' }, 500);

    return json({ ok: true });
  }

  // ==========================================================================
  if (action === 'auth-options') {
    const guardId = payload.guard_id ?? '';
    if (!UUID_RE.test(guardId)) return json({ error: 'invalid guard_id' }, 400);

    const { data: creds } = await admin
      .from('webauthn_credentials')
      .select('credential_id, transports')
      .eq('guard_id', guardId);

    if (!creds || creds.length === 0) {
      return json({ error: 'לא נמצא אימות ביומטרי רשום למכשיר זה' }, 404);
    }

    const options = await generateAuthenticationOptions({
      rpID: rp.rpId,
      userVerification: 'required',
      allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports ?? undefined })),
    });

    await issueChallenge(guardId, 'auth', options.challenge);
    return json({ options });
  }

  // ==========================================================================
  if (action === 'auth-verify') {
    const guardId = payload.guard_id ?? '';
    if (!UUID_RE.test(guardId)) return json({ error: 'invalid guard_id' }, 400);

    const expectedChallenge = await consumeChallenge(guardId, 'auth');
    if (!expectedChallenge) return json({ error: 'האתגר פג תוקף. נסה שוב.' }, 400);

    const credentialId = (payload.credential as { id?: string } | undefined)?.id ?? '';
    const { data: row } = await admin
      .from('webauthn_credentials')
      .select('id, credential_id, public_key, counter, transports')
      .eq('guard_id', guardId)
      .eq('credential_id', credentialId)
      .maybeSingle();
    if (!row) return json({ error: 'אימות הכניסה נכשל' }, 400);

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        // deno-lint-ignore no-explicit-any
        response: payload.credential as any,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpId,
        credential: {
          id: row.credential_id,
          publicKey: pgHexToBytes(row.public_key),
          counter: row.counter,
          transports: row.transports ?? undefined,
        },
      });
    } catch {
      return json({ error: 'אימות הכניסה נכשל' }, 400);
    }
    if (!verification.verified) return json({ error: 'אימות הכניסה נכשל' }, 400);

    await admin
      .from('webauthn_credentials')
      .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
      .eq('id', row.id);

    // --- mint a real session, no password involved ---------------------------
    const { data: userData, error: userErr } = await admin.auth.admin.getUserById(guardId);
    if (userErr || !userData?.user?.email) return json({ error: 'server error' }, 500);

    const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: userData.user.email,
    });
    if (linkErr || !linkData?.properties?.hashed_token) return json({ error: 'server error' }, 500);

    const anon = createClient(url, anonKey, { auth: { persistSession: false } });
    const { data: verifyData, error: verifyErr } = await anon.auth.verifyOtp({
      token_hash: linkData.properties.hashed_token,
      type: 'magiclink',
    });
    if (verifyErr || !verifyData.session) return json({ error: 'server error' }, 500);

    return json({
      access_token: verifyData.session.access_token,
      refresh_token: verifyData.session.refresh_token,
    });
  }

  return json({ error: 'unknown action' }, 400);
});
