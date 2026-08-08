import { useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { CodeInput } from '@/components/auth/CodeInput';
import { Alert, Badge, Button, Card, Spinner, Stepper, cn } from '@/components/ui';
import { EMPLOYEE_CODE_LENGTH, isValidEmployeeCode } from '@/lib/supabase';
import { useRosterCodeStatus, type RosterCodeStatus } from '@/hooks/useManager';
import {
  useAddEmployee,
  useCancelInvitation,
  useSetEmployeeActive,
  useUpdateDefaultKamut,
} from '@/hooks/useTeam';

/**
 * Manager control over who is on the team, as opposed to ManagerDashboard's
 * week-by-week "what are they working". Three operations, none of which
 * touch claim-code -- the one publicly-reachable unauthenticated write path
 * in the system stays exactly as it was:
 *
 *   ADD          creates a roster_codes row -- the same thing seed.sql did by
 *                hand for the first eight. The employee still sets their own
 *                PIN through the normal "קוד עובד" login flow.
 *   REMOVE       sets profiles.is_active = false. Not a delete -- schedule_
 *                assignments and every submission cascade from guard_id, so
 *                deleting the row would erase that person out of past,
 *                including PUBLISHED, rosters. Reversible; erasing history
 *                is not.
 *   DEFAULT כמות the steady state a new week is seeded from (migration 19),
 *                NOT the per-week override the Stepper on TeamTable already
 *                edits -- that one still works exactly as before.
 */
export function TeamManagement() {
  const { data, isLoading, error } = useRosterCodeStatus();

  const rows = data ?? [];
  const active = rows.filter((r) => r.is_claimed && r.is_active);
  const inactive = rows.filter((r) => r.is_claimed && !r.is_active);
  const pending = rows.filter((r) => !r.is_claimed);

  return (
    <AppShell title="ניהול צוות" subtitle="הוספה, הסרה ועדכון ברירות מחדל">
      <div className="space-y-4">
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
            <TeamSection title="פעילים" description="משובצים לסידור השבועי" rows={active} />
            <TeamSection
              title="ממתינים להרשמה"
              description="נוצר קוד עובד, טרם נכנסו למערכת"
              rows={pending}
              empty="אין הזמנות ממתינות"
            />
            {inactive.length > 0 && (
              <TeamSection title="לא פעילים" description="לא משובצים לסידור" rows={inactive} />
            )}
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
        <p className="font-bold text-slate-900">הוספת עובד חדש</p>
        <p className="mt-0.5 text-sm text-slate-500">
          לאחר ההוספה, מסור לעובד את קוד העובד - הוא יגדיר לעצמו סיסמה בכניסה הראשונה.
        </p>
      </div>

      <div>
        <label className="mb-1.5 block text-sm font-semibold text-slate-700" htmlFor="new-emp-name">
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
            'placeholder:text-slate-400 focus:border-brand-400 focus:outline-none',
          )}
        />
      </div>

      <div>
        <p className="mb-1.5 text-sm font-semibold text-slate-700">קוד עובד</p>
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

      <div className="flex items-center justify-between rounded-xl bg-slate-50 px-3 py-2.5">
        <div>
          <p className="text-sm font-bold text-slate-800">ברירת מחדל שבועית</p>
          <p className="mt-0.5 text-xs text-slate-500">כמות ההתחלתית לכל שבוע חדש</p>
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
      <div className="border-b border-slate-200 px-4 py-3">
        <p className="font-bold text-slate-900">
          {title} <span className="text-sm font-normal text-slate-400">({rows.length})</span>
        </p>
        <p className="mt-0.5 text-sm text-slate-500">{description}</p>
      </div>
      {rows.length === 0 ? (
        <p className="px-4 py-6 text-center text-sm text-slate-400">{empty ?? 'אין רשומות'}</p>
      ) : (
        <div className="divide-y divide-slate-100">
          {rows.map((row) => (
            <EmployeeRow key={row.employee_code} row={row} />
          ))}
        </div>
      )}
    </Card>
  );
}

function EmployeeRow({ row }: { row: RosterCodeStatus }) {
  const setActive = useSetEmployeeActive();
  const updateDefault = useUpdateDefaultKamut();
  const cancelInvite = useCancelInvitation();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const saving = setActive.isPending || updateDefault.isPending || cancelInvite.isPending;

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-bold text-slate-900">{row.display_name}</span>
            {row.initial_role === 'manager' && <Badge tone="brand">מנהל</Badge>}
            {row.is_claimed && !row.is_active && <Badge tone="rose">לא פעיל</Badge>}
            {!row.is_claimed && <Badge tone="amber">ממתין</Badge>}
          </div>
          <p className="num mt-0.5 text-xs text-slate-500">{row.employee_code}</p>
        </div>

        <div className="shrink-0 text-center">
          <p className="mb-1 text-[10px] font-bold uppercase text-slate-400">ברירת מחדל</p>
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

      <div className="mt-2 flex flex-wrap gap-2">
        {row.is_claimed ? (
          row.is_active ? (
            <>
              <Button
                size="sm"
                variant={confirmingRemove ? 'danger' : 'ghost'}
                loading={setActive.isPending}
                onClick={() =>
                  confirmingRemove
                    ? setActive.mutate(
                        { profileId: row.profile_id!, isActive: false },
                        { onSuccess: () => setConfirmingRemove(false) },
                      )
                    : setConfirmingRemove(true)
                }
              >
                {confirmingRemove ? 'לחץ שוב להשבתה' : 'השבתה'}
              </Button>
              {confirmingRemove && (
                <Button size="sm" variant="ghost" onClick={() => setConfirmingRemove(false)}>
                  ביטול
                </Button>
              )}
            </>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              loading={setActive.isPending}
              onClick={() => setActive.mutate({ profileId: row.profile_id!, isActive: true })}
            >
              הפעלה מחדש
            </Button>
          )
        ) : (
          <>
            <Button
              size="sm"
              variant={confirmingCancel ? 'danger' : 'ghost'}
              loading={cancelInvite.isPending}
              onClick={() =>
                confirmingCancel
                  ? cancelInvite.mutate(row.employee_code, {
                      onSuccess: () => setConfirmingCancel(false),
                    })
                  : setConfirmingCancel(true)
              }
            >
              {confirmingCancel ? 'לחץ שוב לביטול' : 'ביטול הזמנה'}
            </Button>
            {confirmingCancel && (
              <Button size="sm" variant="ghost" onClick={() => setConfirmingCancel(false)}>
                חזרה
              </Button>
            )}
          </>
        )}
      </div>

      {(setActive.isError || updateDefault.isError || cancelInvite.isError) && (
        <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">
          {[setActive.error, updateDefault.error, cancelInvite.error]
            .filter((e): e is Error => e instanceof Error)
            .map((e) => e.message)
            .join(' · ') || 'הפעולה נכשלה.'}
        </p>
      )}
    </div>
  );
}
