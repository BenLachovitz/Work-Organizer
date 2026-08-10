import { useCallback, useState } from 'react';
import { CodeInput } from '@/components/auth/CodeInput';
import { Alert, Button, Card } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { EMPLOYEE_CODE_LENGTH, PIN_MIN_LENGTH, isValidEmployeeCode } from '@/lib/supabase';

type Step = 'code' | 'pin' | 'setPin';

export function Login() {
  const { lookupCode, signIn, claim, demoMode } = useAuth();

  const [step, setStep] = useState<Step>('code');
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setStep('code');
    setPin('');
    setPinConfirm('');
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
      } catch (e) {
        setError(e instanceof Error ? e.message : 'התחברות נכשלה');
        setPin('');
      } finally {
        setBusy(false);
      }
    },
    [code, signIn],
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
    } catch (e) {
      setError(e instanceof Error ? e.message : 'יצירת הסיסמה נכשלה');
    } finally {
      setBusy(false);
    }
  }, [claim, code, pin, pinConfirm]);

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

              <CodeInput
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
              <Button variant="ghost" fullWidth size="sm" onClick={reset}>
                החלפת קוד עובד
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

              <Alert tone="info">
                הסיסמה מונעת מאחרים להיכנס עם קוד העובד שלך. שמור אותה לעצמך.
              </Alert>

              <div className="space-y-2">
                <p className="text-center text-sm font-semibold text-slate-700 dark:text-slate-300">
                  סיסמה חדשה
                </p>
                <CodeInput
                  value={pin}
                  onChange={setPin}
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
                  onChange={setPinConfirm}
                  length={PIN_MIN_LENGTH}
                  masked
                  disabled={busy}
                  invalid={pinConfirm.length === PIN_MIN_LENGTH && pin !== pinConfirm}
                  ariaLabel="אימות סיסמה"
                />
              </div>

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
        </Card>

        <p className="mt-6 text-center text-xs text-slate-500">
          בעיה בהתחברות? פנה למנהל המשמרת.
        </p>
      </div>
    </div>
  );
}
