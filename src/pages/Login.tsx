import { useCallback, useRef, useState } from 'react';
import { CodeInput, type CodeInputHandle } from '@/components/auth/CodeInput';
import { Alert, Button, Card, Toggle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { usePasskeySupport } from '@/hooks/usePasskey';
import {
  EMPLOYEE_CODE_LENGTH,
  PIN_MIN_LENGTH,
  getPasskeyGuardId,
  getRememberMe,
  isValidEmployeeCode,
  markPasskeyUnlocked,
  setRememberMe,
} from '@/lib/supabase';
import { registerPasskeyDevice } from '@/lib/webauthn';

type Step = 'code' | 'pin' | 'setPin' | 'otpVerify' | 'otpNewPin';

export function Login() {
  const {
    lookupCode,
    signIn,
    claim,
    signInWithPasskey,
    requestPinResetOtp,
    verifyPinResetOtp,
    completePinResetOtp,
    demoMode,
  } = useAuth();
  // Hardware capability only -- the button is now hybrid (see tryPasskey), so
  // it's shown even on a device with nothing registered yet.
  const passkeySupported = usePasskeySupport();
  const codeInputRef = useRef<CodeInputHandle>(null);

  const [step, setStep] = useState<Step>('code');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [otp, setOtp] = useState('');
  const [verifyToken, setVerifyToken] = useState<string | null>(null);
  const [resendDisabled, setResendDisabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  const [passkeyBusy, setPasskeyBusy] = useState(false);
  const [passkeySetupPending, setPasskeySetupPending] = useState(false);
  const [rememberMe, setRememberMeState] = useState(getRememberMe());

  const toggleRememberMe = (value: boolean) => {
    setRememberMe(value);
    setRememberMeState(value);
  };

  /**
   * Hybrid, matching what almost every app with biometric login does: a
   * quick, purely local check for whether THIS device already has a
   * credential. If so, run the real sign-in ceremony as before. If not,
   * there is nothing to challenge yet -- rather than attempt a ceremony
   * that's guaranteed to fail with a confusing system prompt, fall through
   * to the normal badge-code + PIN login: mark intent (picked up by
   * submitPin/submitNewPin below to auto-register right after a successful
   * login, still within the same user-gesture chain this click started) and
   * imperatively focus the code input, since mobile browsers generally only
   * pop the keyboard for a programmatic focus that happens inside a real
   * user gesture like this click -- a plain mount-time autoFocus on page
   * load is often silently ignored.
   */
  const tryPasskey = useCallback(async () => {
    if (!getPasskeyGuardId()) {
      setPasskeySetupPending(true);
      codeInputRef.current?.focus();
      return;
    }
    setPasskeyBusy(true);
    setPasskeyError(null);
    try {
      await signInWithPasskey();
    } catch (e) {
      setPasskeyError(e instanceof Error ? e.message : 'האימות הביומטרי נכשל');
    } finally {
      setPasskeyBusy(false);
    }
  }, [signInWithPasskey]);

  /**
   * Fires immediately after a successful login, still inside the same
   * click's async chain (submitPin/submitNewPin's button press) -- not
   * deferred to a later screen/click, since navigator.credentials.create()
   * generally needs to run reasonably close to a real user gesture to avoid
   * the browser silently refusing it. Best-effort: a failure or cancellation
   * here is swallowed, since GuardHome's passive setup nudge remains as a
   * fallback either way.
   */
  const maybeAutoRegisterPasskey = useCallback(async () => {
    if (!passkeySetupPending) return;
    setPasskeySetupPending(false);
    try {
      await registerPasskeyDevice();
      markPasskeyUnlocked();
    } catch {
      // best-effort -- see comment above
    }
  }, [passkeySetupPending]);

  const reset = () => {
    setStep('code');
    setPin('');
    setPinConfirm('');
    setOtp('');
    setVerifyToken(null);
    setError(null);
  };

  // --- step 1: badge code ---------------------------------------------------
  const submitCode = useCallback(
    async (value: string) => {
      if (!isValidEmployeeCode(value)) return;
      setBusy(true);
      setError(null);
      try {
        const status = await lookupCode(value);
        if (!status.exists) {
          setError('הקוד לא רשום במערכת. פנה למנהל המשמרת.');
          return;
        }
        setDisplayName(status.displayName);
        setStep(status.claimed ? 'pin' : 'setPin');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'שגיאה בבדיקת הקוד');
      } finally {
        setBusy(false);
      }
    },
    [lookupCode],
  );

  // --- step 2a: existing PIN ------------------------------------------------
  const submitPin = useCallback(
    async (value: string) => {
      setBusy(true);
      setError(null);
      try {
        await signIn(code, value);
        await maybeAutoRegisterPasskey();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'התחברות נכשלה');
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [code, signIn, maybeAutoRegisterPasskey],
  );

  // --- step 2b: first login, choose a PIN -----------------------------------
  const submitNewPin = useCallback(async () => {
    if (pin.length < PIN_MIN_LENGTH) {
      setError(`הסיסמה חייבת להכיל לפחות ${PIN_MIN_LENGTH} ספרות`);
      return;
    }
    if (pin !== pinConfirm) {
      setError('הסיסמאות אינן תואמות');
      setPinConfirm('');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await claim(code, pin);
      await maybeAutoRegisterPasskey();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'יצירת הסיסמה נכשלה');
    } finally {
      setBusy(false);
    }
  }, [claim, code, pin, pinConfirm, maybeAutoRegisterPasskey]);

  // --- forgot PIN: 1) request a WhatsApp OTP ---------------------------------
  const submitForgotPin = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await requestPinResetOtp(code);
      setOtp('');
      setStep('otpVerify');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שליחת הקוד נכשלה');
    } finally {
      setBusy(false);
    }
  }, [code, requestPinResetOtp]);

  const resendOtp = useCallback(async () => {
    setResendDisabled(true);
    setError(null);
    try {
      await requestPinResetOtp(code);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'שליחת הקוד נכשלה');
    } finally {
      setTimeout(() => setResendDisabled(false), 30_000);
    }
  }, [code, requestPinResetOtp]);

  // --- forgot PIN: 2) verify the OTP -----------------------------------------
  const submitOtp = useCallback(
    async (value: string) => {
      setBusy(true);
      setError(null);
      try {
        const { verifyToken: token } = await verifyPinResetOtp(code, value);
        setVerifyToken(token);
        setOtp('');
        setStep('otpNewPin');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'קוד שגוי');
        setOtp('');
      } finally {
        setBusy(false);
      }
    },
    [code, verifyPinResetOtp],
  );

  // --- forgot PIN: 3) choose a new PIN ---------------------------------------
  const submitOtpNewPin = useCallback(async () => {
    if (pin.length < PIN_MIN_LENGTH) {
      setError(`הסיסמה חייבת להכיל לפחות ${PIN_MIN_LENGTH} ספרות`);
      return;
    }
    if (pin !== pinConfirm) {
      setError('הסיסמאות אינן תואמות');
      setPinConfirm('');
      return;
    }
    if (!verifyToken) {
      setError('האימות פג תוקף. התחל שוב.');
      setStep('pin');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await completePinResetOtp(code, verifyToken, pin);
      await maybeAutoRegisterPasskey();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'איפוס הסיסמה נכשל');
    } finally {
      setBusy(false);
    }
  }, [code, pin, pinConfirm, verifyToken, completePinResetOtp, maybeAutoRegisterPasskey]);

  return (
    // svh, not dvh: on first paint some mobile browsers resolve `dvh` against
    // the LARGE viewport (as if the address bar were already hidden) before
    // the first scroll/resize event corrects it, which centers this block
    // against a taller-than-actually-visible height -- content sits above the
    // true visual centre with a lopsided gap left below it. `svh` is always
    // the smallest possible viewport, so it matches what's on screen from the
    // very first frame regardless of address-bar state.
    //
    // index.html sets viewport-fit=cover, so this page draws edge-to-edge
    // under the status bar and any gesture-nav bar. The top inset is already
    // handled globally -- index.css puts `padding-top: env(safe-area-inset-top)`
    // on <body> itself -- so only the BOTTOM inset needs handling here: this
    // page has no bottom nav (unlike the authenticated pages' AppShell,
    // where BottomNav is a normal flex child of the shell and reserves its
    // own space naturally) to already push content up from under a
    // gesture-nav bar. max() against the original 2.5rem so devices with no
    // inset are unaffected.
    <div
      className="grid min-h-svh place-items-center bg-gradient-to-b from-slate-900 via-slate-900 to-brand-950 px-4 pt-10"
      style={{ paddingBottom: 'max(2.5rem, env(safe-area-inset-bottom))' }}
    >
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid size-16 place-items-center rounded-2xl bg-white/10 ring-1 ring-white/20 backdrop-blur">
            <svg className="size-9 text-white" viewBox="0 0 24 24" fill="none" strokeWidth="1.8">
              <path
                d="M12 3 4.5 6v6c0 4.4 3.1 8.3 7.5 9.4 4.4-1.1 7.5-5 7.5-9.4V6L12 3Z"
                stroke="currentColor"
                strokeLinejoin="round"
              />
              <path
                d="m9 12 2.2 2.2L15.5 10"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-2xl font-extrabold text-white">סידור משמרות</h1>
          <p className="mt-1 text-sm text-slate-400">מערכת שיבוץ אוטומטית לצוות האבטחה</p>
        </div>

        <Card className="space-y-5">
          {demoMode && (
            <Alert tone="warn" title="מצב הדגמה">
              אין חיבור לשרת. אפשר להיכנס עם כל קוד לדוגמה (למשל{' '}
              <span className="num font-bold">005396</span>) כדי לראות את הממשק בלבד.
            </Alert>
          )}

          {/* ---------------- step: code ---------------- */}
          {step === 'code' && (
            <>
              <div className="text-center">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  כניסה למערכת
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  הזן את קוד העובד בן 6 הספרות
                </p>
              </div>

              {passkeySupported && !demoMode && (
                <>
                  {passkeyError && <Alert tone="error">{passkeyError}</Alert>}
                  {passkeySetupPending && (
                    <Alert tone="info">
                      היכנס תחילה עם קוד העובד והסיסמה שלך כדי להגדיר כניסה ביומטרית.
                    </Alert>
                  )}
                  <Button
                    fullWidth
                    size="lg"
                    variant="secondary"
                    loading={passkeyBusy}
                    onClick={() => void tryPasskey()}
                  >
                    כניסה עם Face ID / טביעת אצבע
                  </Button>
                  <div className="flex items-center gap-3 text-xs text-slate-400">
                    <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                    או
                    <span className="h-px flex-1 bg-slate-200 dark:bg-slate-700" />
                  </div>
                </>
              )}

              <CodeInput
                ref={codeInputRef}
                value={code}
                onChange={setCode}
                length={EMPLOYEE_CODE_LENGTH}
                autoFocus
                disabled={busy}
                invalid={Boolean(error)}
                onComplete={(v) => void submitCode(v)}
                ariaLabel="קוד עובד"
              />

              {error && <Alert tone="error">{error}</Alert>}

              <Button
                fullWidth
                size="lg"
                loading={busy}
                disabled={!isValidEmployeeCode(code)}
                onClick={() => void submitCode(code)}
              >
                המשך
              </Button>
            </>
          )}

          {/* ---------------- step: existing PIN ---------------- */}
          {step === 'pin' && (
            <>
              <Button variant="ghost" size="sm" onClick={reset}>
                → קוד אחר
              </Button>

              <div className="text-center">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  שלום{displayName ? `, ${displayName}` : ''}
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  הזן את הסיסמה האישית שלך
                </p>
              </div>

              <CodeInput
                value={pin}
                onChange={setPin}
                length={PIN_MIN_LENGTH}
                masked
                autoFocus
                disabled={busy}
                invalid={Boolean(error)}
                onComplete={(v) => void submitPin(v)}
                ariaLabel="סיסמה אישית"
              />

              <Toggle
                checked={rememberMe}
                onChange={toggleRememberMe}
                label="הישאר מחובר במכשיר זה"
                description="ללא כך, המערכת תבקש התחברות מחדש בכל פתיחה. בטל אם זה מכשיר משותף."
              />

              {error && <Alert tone="error">{error}</Alert>}

              <Button
                fullWidth
                size="lg"
                loading={busy}
                disabled={pin.length < PIN_MIN_LENGTH}
                onClick={() => void submitPin(pin)}
              >
                התחבר
              </Button>
              <Button
                variant="secondary"
                fullWidth
                size="sm"
                loading={busy}
                onClick={() => void submitForgotPin()}
              >
                שכחתי סיסמה
              </Button>
            </>
          )}

          {/* ---------------- step: first login ---------------- */}
          {step === 'setPin' && (
            <>
              <div className="text-center">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  ברוך הבא{displayName ? `, ${displayName}` : ''}
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  זו הכניסה הראשונה שלך. בחר סיסמה אישית בת {PIN_MIN_LENGTH} ספרות.
                </p>
              </div>

              <PinChooser
                pin={pin}
                pinConfirm={pinConfirm}
                onPinChange={setPin}
                onPinConfirmChange={setPinConfirm}
                busy={busy}
                rememberMe={rememberMe}
                onToggleRememberMe={toggleRememberMe}
              />

              {error && <Alert tone="error">{error}</Alert>}

              <Button
                fullWidth
                size="lg"
                loading={busy}
                disabled={pin.length < PIN_MIN_LENGTH || pinConfirm.length < PIN_MIN_LENGTH}
                onClick={() => void submitNewPin()}
              >
                שמור והתחבר
              </Button>
              <Button variant="ghost" fullWidth size="sm" onClick={reset}>
                החלפת קוד עובד
              </Button>
            </>
          )}

          {/* ---------------- forgot PIN: enter the WhatsApp code ---------------- */}
          {step === 'otpVerify' && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setStep('pin')}>
                → חזרה
              </Button>

              <div className="text-center">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  אימות קוד
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  שלחנו קוד אימות בן {PIN_MIN_LENGTH} ספרות ב-WhatsApp. הזן אותו כאן.
                </p>
              </div>

              <CodeInput
                value={otp}
                onChange={setOtp}
                length={PIN_MIN_LENGTH}
                autoFocus
                disabled={busy}
                invalid={Boolean(error)}
                onComplete={(v) => void submitOtp(v)}
                ariaLabel="קוד אימות"
              />

              {error && <Alert tone="error">{error}</Alert>}

              <Button
                fullWidth
                size="lg"
                loading={busy}
                disabled={otp.length < PIN_MIN_LENGTH}
                onClick={() => void submitOtp(otp)}
              >
                אימות
              </Button>
              <Button
                variant="ghost"
                fullWidth
                size="sm"
                disabled={resendDisabled}
                onClick={() => void resendOtp()}
              >
                לא קיבלת קוד? שלח שוב
              </Button>
            </>
          )}

          {/* ---------------- forgot PIN: choose a new PIN ---------------- */}
          {step === 'otpNewPin' && (
            <>
              <Button variant="ghost" size="sm" onClick={() => setStep('otpVerify')}>
                → חזרה
              </Button>

              <div className="text-center">
                <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">
                  בחירת סיסמה חדשה
                </h2>
                <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                  הקוד אומת בהצלחה. בחר סיסמה אישית חדשה בת {PIN_MIN_LENGTH} ספרות.
                </p>
              </div>

              <PinChooser
                pin={pin}
                pinConfirm={pinConfirm}
                onPinChange={setPin}
                onPinConfirmChange={setPinConfirm}
                busy={busy}
                rememberMe={rememberMe}
                onToggleRememberMe={toggleRememberMe}
              />

              {error && <Alert tone="error">{error}</Alert>}

              <Button
                fullWidth
                size="lg"
                loading={busy}
                disabled={pin.length < PIN_MIN_LENGTH || pinConfirm.length < PIN_MIN_LENGTH}
                onClick={() => void submitOtpNewPin()}
              >
                שמירת הסיסמה
              </Button>
            </>
          )}
        </Card>

        <p className="mt-6 text-center text-xs text-slate-500">
          בעיה בהתחברות? פנה למנהל המשמרת.
        </p>
      </div>
    </div>
  );
}

/**
 * The "choose a new PIN" pair -- new PIN + confirm + remember-me -- shared
 * verbatim between first-time registration ('setPin') and the WhatsApp-OTP
 * forgot-PIN flow's last step ('otpNewPin'). Only the surrounding heading,
 * info copy, submit button and back-link differ between the two callers, so
 * only this inner block is factored out rather than the whole step.
 */
function PinChooser({
  pin,
  pinConfirm,
  onPinChange,
  onPinConfirmChange,
  busy,
  rememberMe,
  onToggleRememberMe,
}: {
  pin: string;
  pinConfirm: string;
  onPinChange: (v: string) => void;
  onPinConfirmChange: (v: string) => void;
  busy: boolean;
  rememberMe: boolean;
  onToggleRememberMe: (v: boolean) => void;
}) {
  return (
    <>
      <Alert tone="info">הסיסמה מונעת מאחרים להיכנס עם קוד העובד שלך. שמור אותה לעצמך.</Alert>

      <div className="space-y-2">
        <p className="text-center text-sm font-semibold text-slate-700 dark:text-slate-300">
          סיסמה חדשה
        </p>
        <CodeInput
          value={pin}
          onChange={onPinChange}
          length={PIN_MIN_LENGTH}
          masked
          autoFocus
          disabled={busy}
          ariaLabel="סיסמה חדשה"
        />
      </div>

      <div className="space-y-2">
        <p className="text-center text-sm font-semibold text-slate-700 dark:text-slate-300">
          אימות סיסמה
        </p>
        <CodeInput
          value={pinConfirm}
          onChange={onPinConfirmChange}
          length={PIN_MIN_LENGTH}
          masked
          disabled={busy}
          invalid={pinConfirm.length === PIN_MIN_LENGTH && pin !== pinConfirm}
          ariaLabel="אימות סיסמה"
        />
      </div>

      <Toggle
        checked={rememberMe}
        onChange={onToggleRememberMe}
        label="הישאר מחובר במכשיר זה"
        description="ללא כך, המערכת תבקש התחברות מחדש בכל פתיחה. בטל אם זה מכשיר משותף."
      />
    </>
  );
}
