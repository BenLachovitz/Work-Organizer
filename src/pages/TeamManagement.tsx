import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CodeInput } from '@/components/auth/CodeInput';
import { Alert, Badge, Button, ButtonLink, Card, Spinner, Stepper, cn } from '@/components/ui';
import { EMPLOYEE_CODE_LENGTH, PIN_MIN_LENGTH, isValidEmployeeCode } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { useRosterCodeStatus, type RosterCodeStatus } from '@/hooks/useManager';
import {
  useAddEmployee,
  useDeleteEmployee,
  useResetGuardPin,
  useUpdateDefaultKamut,
} from '@/hooks/useTeam';
import { useViewMode } from '@/contexts/ViewModeContext';
import { visibleToViewMode } from '@/lib/viewMode';

/**
 * Manager control over who is on the team, as opposed to the weekly
 * workflow's "what are they working" (ManagerDashboard/ManagerSummary/
 * ManagerRoster). Four operations; only ADD touches claim-code, the one
 * publicly-reachable unauthenticated write path in the system, and only by
 * creating the invitation row it reads:
 *
 *   ADD          creates a roster_codes row -- the same thing seed.sql did by
 *                hand for the first eight. The employee still sets their own
 *                PIN through the normal "קוד עובד" login flow.
 *   RESET PIN    for a guard who forgot their PIN and has no self-service way
 *                back in (the PIN IS their GoTrue password -- there is no
 *                separate "forgot password" flow). Goes through the
 *                reset-pin Edge Function to reset just the password on their
 *                EXISTING auth.users row -- profile, roster history and
 *                every submission stay exactly as they were.
 *   DELETE       genuinely erases the employee: profile, preferences,
 *                submissions and every roster assignment they were ever part
 *                of, including a published one (delete_employee, migration
 *                21). There is no undo -- the manager asked for this over the
 *                earlier deactivate-only version, so the confirm step below
 *                says exactly what it removes rather than softening it.
 *   DEFAULT כמות the steady state a new week is seeded from (migration 19),
 *                NOT the per-week override the Stepper on TeamTable already
 *                edits -- that one still works exactly as before.
 */
export function TeamManagement() {
  const { data, isLoading, error } = useRosterCodeStatus();
  const { viewMode } = useViewMode();

  const rows = data ?? [];
  // existingCodes (below) deliberately stays unfiltered -- a demo code hidden
  // by the current view mode must still block re-registering the same code.
  const visibleRows = rows.filter((r) => visibleToViewMode(r, viewMode));
  const active = visibleRows.filter((r) => r.is_claimed);
  const pending = visibleRows.filter((r) => !r.is_claimed);

  return (
    <AppShell title="ניהול צוות" subtitle="הוספה, מחיקה ועדכון ברירות מחדל">
      <div className="space-y-4">
        <ButtonLink to="/manage" variant="ghost" size="sm">
          → חזרה לניהול
        </ButtonLink>

        {pending.length > 0 && (
          <Alert tone="info" title={`${pending.length} קודים טרם נרשמו למערכת`}>
            {pending.map((c) => `${c.display_name} (${c.employee_code})`).join(', ')}
          </Alert>
        )}

        <AddEmployeeCard existingCodes={rows.map((r) => r.employee_code)} />

        {isLoading ? (
          <Card>
            <div className="grid place-items-center py-6">
              <Spinner className="size-6 text-brand-600" />
            </div>
          </Card>
        ) : error ? (
          <Alert tone="error" title="שגיאה בטעינת הצוות">
            {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
          </Alert>
        ) : (
          <>
            <TeamSection title="פעילים" description="רשומים ומשובצים לסידור" rows={active} />
            <TeamSection
              title="ממתינים להרשמה"
              description="נוצר קוד עובד, טרם נכנסו למערכת"
              rows={pending}
              empty="אין הזמנות ממתינות"
            />
          </>
        )}
      </div>
    </AppShell>
  );
}

// ---------------------------------------------------------------------------

function AddEmployeeCard({ existingCodes }: { existingCodes: string[] }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [defaultKamut, setDefaultKamut] = useState(0);
  const add = useAddEmployee();

  const codeTaken = existingCodes.includes(code);
  const canSubmit = name.trim().length > 0 && isValidEmployeeCode(code) && !codeTaken;

  const submit = () => {
    if (!canSubmit) return;
    add.mutate(
      { employeeCode: code, displayName: name.trim(), defaultKamut },
      {
        onSuccess: () => {
          setName('');
          setCode('');
          setDefaultKamut(0);
        },
      },
    );
  };

  return (
    <Card className="space-y-4">
      <div>
        <p className="font-bold text-slate-900 dark:text-slate-100">הוספת עובד חדש</p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
          לאחר ההוספה, מסור לעובד את קוד העובד - הוא יגדיר לעצמו סיסמה בכניסה הראשונה.
        </p>
      </div>

      <div>
        <label
          className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-300"
          htmlFor="new-emp-name"
        >
          שם
        </label>
        <input
          id="new-emp-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="שם העובד"
          className={cn(
            'w-full rounded-xl border-2 border-slate-200 p-3 text-sm text-slate-800',
            'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
            'placeholder:text-slate-400 focus:border-brand-400 focus:outline-none dark:placeholder:text-slate-500',
          )}
        />
      </div>

      <div>
        <p className="mb-1.5 text-sm font-semibold text-slate-700 dark:text-slate-300">קוד עובד</p>
        <CodeInput
          value={code}
          onChange={setCode}
          length={EMPLOYEE_CODE_LENGTH}
          invalid={codeTaken}
          ariaLabel="קוד עובד חדש"
        />
        {codeTaken && (
          <p className="mt-1.5 text-center text-xs font-semibold text-rose-600">
            קוד זה כבר קיים במערכת
          </p>
        )}
      </div>

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5 dark:bg-slate-800">
        <div>
          <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
            ברירת מחדל שבועית
          </p>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            כמות ההתחלתית לכל שבוע חדש
          </p>
        </div>
        <Stepper value={defaultKamut} onChange={setDefaultKamut} />
      </div>

      {add.isError && (
        <Alert tone="error">
          {add.error instanceof Error ? add.error.message : 'ההוספה נכשלה.'}
        </Alert>
      )}

      <Button fullWidth disabled={!canSubmit} loading={add.isPending} onClick={submit}>
        הוספת עובד
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function TeamSection({
  title,
  description,
  rows,
  empty,
}: {
  title: string;
  description: string;
  rows: RosterCodeStatus[];
  empty?: string;
}) {
  return (
    <Card className="p-0">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <p className="font-bold text-slate-900 dark:text-slate-100">
          {title}{' '}
          <span className="text-sm font-normal text-slate-400 dark:text-slate-500">
            ({rows.length})
          </span>
        </p>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400 dark:text-slate-500">
          {empty ?? 'אין רשומות'}
        </p>
      ) : (
        <div className="divide-y divide-slate-100 dark:divide-slate-800">
          {rows.map((row) => (
            <EmployeeRow key={row.employee_code} row={row} />
          ))}
        </div>
      )}
    </Card>
  );
}

function EmployeeRow({ row }: { row: RosterCodeStatus }) {
  const { profile } = useAuth();
  const updateDefault = useUpdateDefaultKamut();
  const deleteEmployee = useDeleteEmployee();
  const resetPin = useResetGuardPin();
  const [confirming, setConfirming] = useState(false);
  const [resettingPin, setResettingPin] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [pinResetDone, setPinResetDone] = useState(false);

  const saving = updateDefault.isPending || deleteEmployee.isPending;
  const isSelf = row.profile_id !== null && row.profile_id === profile?.id;

  const submitPinReset = () => {
    if (!row.profile_id || newPin.length !== PIN_MIN_LENGTH) return;
    resetPin.mutate(
      { guardId: row.profile_id, newPin },
      {
        onSuccess: () => {
          setResettingPin(false);
          setNewPin('');
          setPinResetDone(true);
        },
      },
    );
  };

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-bold text-slate-900 dark:text-slate-100">
              {row.display_name}
            </span>
            {row.initial_role === 'manager' && <Badge tone="brand">מנהל</Badge>}
            {!row.is_claimed && <Badge tone="amber">ממתין</Badge>}
          </div>
          <p className="num mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {row.employee_code}
          </p>
        </div>

        <div className="shrink-0 text-center">
          <p className="mb-1 text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500">
            ברירת מחדל
          </p>
          <Stepper
            value={row.default_kamut}
            disabled={saving}
            onChange={(v) =>
              updateDefault.mutate({
                employeeCode: row.employee_code,
                profileId: row.profile_id,
                value: v,
              })
            }
          />
        </div>
      </div>

      {isSelf ? (
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          זהו החשבון שלך - לא ניתן למחוק אותו כאן.
        </p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {row.is_claimed && row.profile_id && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setResettingPin((v) => !v);
                setPinResetDone(false);
              }}
            >
              {resettingPin ? 'ביטול איפוס' : 'שכח/ה PIN - איפוס'}
            </Button>
          )}
          <Button
            size="sm"
            variant={confirming ? 'danger' : 'ghost'}
            loading={deleteEmployee.isPending}
            onClick={() =>
              confirming
                ? deleteEmployee.mutate(row.employee_code, {
                    onSuccess: () => setConfirming(false),
                  })
                : setConfirming(true)
            }
          >
            {confirming ? 'לחץ שוב למחיקה סופית' : 'מחיקה'}
          </Button>
          {confirming && (
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
              ביטול
            </Button>
          )}
        </div>
      )}

      {confirming && row.is_claimed && (
        <Alert tone="warn">
          פעולה זו תמחק לצמיתות את {row.display_name} מהמערכת - כולל כל היסטוריית המשמרות, הבקשות
          וההגשות שלו/שלה, בכל הסידורים כולל סידורים שכבר פורסמו. אי אפשר לבטל.
        </Alert>
      )}

      {resettingPin && (
        <div className="mt-2 space-y-2 rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800">
          <p className="text-xs text-slate-600 dark:text-slate-300">
            בחר קוד PIN חדש בן {PIN_MIN_LENGTH} ספרות עבור {row.display_name} ומסור לו/לה אותו -
            הפרופיל, ההיסטוריה וכל הסידורים שלו/שלה לא ישתנו.
          </p>
          <CodeInput
            value={newPin}
            onChange={setNewPin}
            length={PIN_MIN_LENGTH}
            ariaLabel={`PIN חדש עבור ${row.display_name}`}
          />
          <Button
            size="sm"
            fullWidth
            disabled={newPin.length !== PIN_MIN_LENGTH}
            loading={resetPin.isPending}
            onClick={submitPinReset}
          >
            אפס סיסמה
          </Button>
        </div>
      )}

      {pinResetDone && (
        <Alert tone="success">הסיסמה אופסה. מסור ל{row.display_name} את הקוד החדש שבחרת.</Alert>
      )}

      {(updateDefault.isError || deleteEmployee.isError || resetPin.isError) && (
        <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800 dark:bg-rose-950/50 dark:text-rose-400">
          {[updateDefault.error, deleteEmployee.error, resetPin.error]
            .filter((e): e is Error => e instanceof Error)
            .map((e) => e.message)
            .join(' · ') || 'הפעולה נכשלה.'}
        </p>
      )}
    </div>
  );
}
