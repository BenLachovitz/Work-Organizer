import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  codeToEmail,
  getPasskeyGuardId,
  isPasskeyUnlockFresh,
  isSupabaseConfigured,
  markPasskeyUnlocked,
  setPasskeyGuardId,
  supabase,
} from '@/lib/supabase';
import { signInWithPasskeyDevice } from '@/lib/webauthn';
import { invokeEdgeFunction } from '@/lib/edgeFunctions';
import type { Profile } from '@/types/database';

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn';

/** What the login screen needs to know about a badge code before asking for a PIN. */
export interface CodeStatus {
  exists: boolean;
  claimed: boolean;
  displayName: string | null;
}

interface AuthValue {
  status: AuthStatus;
  session: Session | null;
  profile: Profile | null;
  isManager: boolean;
  /** True when running without a Supabase project, for layout preview only. */
  demoMode: boolean;
  lookupCode: (employeeCode: string) => Promise<CodeStatus>;
  signIn: (employeeCode: string, pin: string) => Promise<void>;
  claim: (employeeCode: string, pin: string) => Promise<void>;
  signInWithPasskey: () => Promise<void>;
  /** Sends a WhatsApp OTP to the guard's phone on file (whatsapp-pin-reset). */
  requestPinResetOtp: (employeeCode: string) => Promise<void>;
  /** Verifies the OTP; returns a one-time token required by completePinResetOtp. */
  verifyPinResetOtp: (employeeCode: string, otp: string) => Promise<{ verifyToken: string }>;
  /** Resets the PIN using a verified OTP's token, then signs the guard in. */
  completePinResetOtp: (employeeCode: string, verifyToken: string, newPin: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

// ---------------------------------------------------------------------------
// Demo roster -- ONLY used when no Supabase project is configured, so the RTL
// layout can be reviewed before the backend exists. Every code below is a POC
// placeholder from supabase/seed.sql.
// ---------------------------------------------------------------------------
const DEMO_PROFILES: Record<string, Pick<Profile, 'display_name' | 'role'>> = {
  '005396': { display_name: 'בן', role: 'manager' },
  '100001': { display_name: 'יובל', role: 'guard' },
  '100002': { display_name: 'לוק', role: 'guard' },
  '100003': { display_name: 'הודיה', role: 'guard' },
  '100004': { display_name: 'שלי', role: 'guard' },
  '100005': { display_name: 'ים', role: 'guard' },
  '100006': { display_name: 'עידן', role: 'guard' },
  '100007': { display_name: 'ניתאי', role: 'guard' },
};

const DEMO_KEY = 'wo.demo.code';

export function AuthProvider({ children }: { children: ReactNode }) {
  // Demo mode is implied when there is no project, and can also be forced with
  // VITE_DEMO_MODE=1. The override exists so the UI stays previewable during
  // the window where credentials are configured but the claim-code Edge
  // Function does not exist yet -- otherwise login would simply fail.
  const demoMode = !isSupabaseConfigured || import.meta.env.VITE_DEMO_MODE === '1';

  const [status, setStatus] = useState<AuthStatus>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);

  const makeDemoProfile = useCallback((code: string): Profile => {
    const base = DEMO_PROFILES[code] ?? { display_name: 'מאבטח', role: 'guard' as const };
    return {
      id: `demo-${code}`,
      employee_code: code,
      display_name: base.display_name,
      role: base.role,
      is_active: true,
      created_at: new Date().toISOString(),
      default_kamut: 0,
      // This offline-preview roster is 1:1 with the real seeded mock guards
      // (every code but Ben's), so the flag can just mirror that split.
      is_demo: code !== '005396',
      phone_number: null,
    };
  }, []);

  const loadProfile = useCallback(async (userId: string) => {
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single<Profile>();
    if (error) throw new Error(error.message);
    return data;
  }, []);

  // --- bootstrap -----------------------------------------------------------
  useEffect(() => {
    let cancelled = false;

    if (demoMode) {
      const saved = sessionStorage.getItem(DEMO_KEY);
      if (saved) setProfile(makeDemoProfile(saved));
      setStatus(saved ? 'signedIn' : 'signedOut');
      return;
    }

    void (async () => {
      const { data } = await supabase!.auth.getSession();
      if (cancelled) return;
      // A device with a registered passkey but no recent real verification
      // (isPasskeyUnlockFresh) is signed out locally rather than shown a
      // separate "locked" screen -- deliberately the same plain Login page
      // every signed-out guard sees, which already offers the passkey
      // sign-in button up front. `scope: 'local'` only clears THIS device's
      // stored session; it must never revoke a session this guard has active
      // on another device just because one phone's grace window lapsed.
      if (data.session && getPasskeyGuardId() && !isPasskeyUnlockFresh()) {
        await supabase!.auth.signOut({ scope: 'local' });
        if (!cancelled) setStatus('signedOut');
        return;
      }
      if (data.session) {
        setSession(data.session);
        try {
          setProfile(await loadProfile(data.session.user.id));
          setStatus('signedIn');
        } catch {
          setStatus('signedOut');
        }
      } else {
        setStatus('signedOut');
      }
    })();

    const { data: sub } = supabase!.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        setStatus('signedOut');
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [demoMode, loadProfile, makeDemoProfile]);

  // --- actions -------------------------------------------------------------

  const lookupCode = useCallback(
    async (employeeCode: string): Promise<CodeStatus> => {
      if (demoMode) {
        const hit = DEMO_PROFILES[employeeCode];
        return {
          exists: Boolean(hit),
          claimed: true, // demo skips the set-PIN flow
          displayName: hit?.display_name ?? null,
        };
      }
      // roster_codes is sealed from the publishable key (RLS deny-all + no
      // grants), so this cannot be a direct table read -- it must go through
      // the rate-limited function.
      return invokeEdgeFunction<CodeStatus>('claim-code', {
        action: 'status',
        employee_code: employeeCode,
      });
    },
    [demoMode],
  );

  const signIn = useCallback(
    async (employeeCode: string, pin: string) => {
      if (demoMode) {
        if (!DEMO_PROFILES[employeeCode]) throw new Error('קוד לא קיים');
        sessionStorage.setItem(DEMO_KEY, employeeCode);
        setProfile(makeDemoProfile(employeeCode));
        setStatus('signedIn');
        return;
      }
      const { data, error } = await supabase!.auth.signInWithPassword({
        email: codeToEmail(employeeCode),
        password: pin,
      });
      if (error) throw new Error('קוד או סיסמה שגויים');
      // A shared-device edge case: a stale passkey hint from a PREVIOUS guard
      // on this device must not gate the app-restart lock screen behind an
      // identity this guard has no way to satisfy.
      const existingHint = getPasskeyGuardId();
      if (existingHint && existingHint !== data.user.id) setPasskeyGuardId(null);
      setSession(data.session);
      setProfile(await loadProfile(data.user.id));
      setStatus('signedIn');
    },
    [demoMode, loadProfile, makeDemoProfile],
  );

  const signInWithPasskey = useCallback(async () => {
    if (demoMode) throw new Error('אימות ביומטרי אינו זמין במצב הדגמה');
    const guardId = getPasskeyGuardId();
    if (!guardId) throw new Error('לא נמצא אימות ביומטרי רשום למכשיר זה');
    const { access_token, refresh_token } = await signInWithPasskeyDevice(guardId);
    const { data, error } = await supabase!.auth.setSession({ access_token, refresh_token });
    if (error || !data.session || !data.user) {
      throw new Error(error?.message ?? 'האימות הביומטרי נכשל');
    }
    markPasskeyUnlocked();
    setSession(data.session);
    setProfile(await loadProfile(data.user.id));
    setStatus('signedIn');
  }, [demoMode, loadProfile]);

  const claim = useCallback(
    async (employeeCode: string, pin: string) => {
      if (demoMode) return signIn(employeeCode, pin);
      await invokeEdgeFunction('claim-code', { action: 'claim', employee_code: employeeCode, pin });
      await signIn(employeeCode, pin);
    },
    [demoMode, signIn],
  );

  const requestPinResetOtp = useCallback(
    async (employeeCode: string) => {
      if (demoMode) throw new Error('שחזור סיסמה אינו זמין במצב הדגמה');
      await invokeEdgeFunction('whatsapp-pin-reset', {
        action: 'otp_request',
        employee_code: employeeCode,
      });
    },
    [demoMode],
  );

  const verifyPinResetOtp = useCallback(
    async (employeeCode: string, otp: string): Promise<{ verifyToken: string }> => {
      if (demoMode) throw new Error('שחזור סיסמה אינו זמין במצב הדגמה');
      const { verify_token } = await invokeEdgeFunction<{ verify_token: string }>(
        'whatsapp-pin-reset',
        { action: 'otp_verify', employee_code: employeeCode, otp },
      );
      return { verifyToken: verify_token };
    },
    [demoMode],
  );

  const completePinResetOtp = useCallback(
    async (employeeCode: string, verifyToken: string, newPin: string) => {
      if (demoMode) throw new Error('שחזור סיסמה אינו זמין במצב הדגמה');
      await invokeEdgeFunction('whatsapp-pin-reset', {
        action: 'otp_complete',
        employee_code: employeeCode,
        verify_token: verifyToken,
        new_pin: newPin,
      });
      await signIn(employeeCode, newPin);
    },
    [demoMode, signIn],
  );

  const signOut = useCallback(async () => {
    if (demoMode) {
      sessionStorage.removeItem(DEMO_KEY);
    } else {
      await supabase!.auth.signOut();
    }
    setProfile(null);
    setSession(null);
    setStatus('signedOut');
  }, [demoMode]);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      session,
      profile,
      isManager: profile?.role === 'manager' || profile?.role === 'admin',
      demoMode,
      lookupCode,
      signIn,
      claim,
      signInWithPasskey,
      requestPinResetOtp,
      verifyPinResetOtp,
      completePinResetOtp,
      signOut,
    }),
    [
      status,
      session,
      profile,
      demoMode,
      lookupCode,
      signIn,
      claim,
      signInWithPasskey,
      requestPinResetOtp,
      verifyPinResetOtp,
      completePinResetOtp,
      signOut,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
