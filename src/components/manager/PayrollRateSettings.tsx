import { useState } from 'react';
import { Alert, Button, Collapsible, DateField, Spinner, cn } from '@/components/ui';
import { useAddRate, useDeleteRate, useRateHistory, type PayrollRate } from '@/hooks/useWorkLog';
import { todayInIsrael, type DateKey } from '@/lib/dates';

const ROLE_LABEL: Record<PayrollRate['role'], string> = { guard: 'מאבטחים', manager: 'מנהל' };

/**
 * Standing, global rates for the estimated-salary feature (/worklog) --
 * one flat hourly wage for every guard, a separate one for the manager, as
 * an APPEND-ONLY HISTORY rather than a single current value: changing a
 * rate records a new entry effective from a chosen date, and every
 * already-passed month keeps resolving to whatever rate was actually in
 * effect back then. Nothing here is per-individual (see TeamManagement for
 * actual per-guard settings like default כמות, which this is NOT one of).
 */
export function PayrollRateSettings({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const { data, isLoading, error } = useRateHistory();

  const currentFor = (role: PayrollRate['role']) => {
    const rows = (data ?? []).filter((r) => r.role === role);
    return rows.length ? rows[rows.length - 1]!.hourly_rate : null;
  };

  return (
    <Collapsible
      title="שכר לשעה · יומן עבודה"
      summary={
        isLoading
          ? 'טוען…'
          : data
            ? `מאבטחים ₪${currentFor('guard') ?? '—'} · מנהל ₪${currentFor('manager') ?? '—'}`
            : 'שגיאה בטעינה'
      }
      defaultExpanded={defaultExpanded}
    >
      {error ? (
        <Alert tone="error">{error instanceof Error ? error.message : 'שגיאה בטעינה.'}</Alert>
      ) : isLoading || !data ? (
        <div className="grid place-items-center py-4">
          <Spinner className="size-5 text-brand-600" />
        </div>
      ) : (
        <div className="space-y-5">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            משפיע רק על הערכת השכר ב"יומן עבודה" - אינו מחובר למערכת שכר אמיתית ואינו נוגע לסידור
            המשמרות עצמו. שינוי שכר חל מהתאריך שתבחר ואילך בלבד - חודשים שעברו ממשיכים להיחשב
            לפי השכר שהיה בתוקף אז.
          </p>
          <RoleSection role="guard" history={data.filter((r) => r.role === 'guard')} />
          <RoleSection role="manager" history={data.filter((r) => r.role === 'manager')} />
        </div>
      )}
    </Collapsible>
  );
}

function RoleSection({
  role,
  history,
}: {
  role: PayrollRate['role'];
  history: PayrollRate[];
}) {
  const add = useAddRate();
  const del = useDeleteRate();
  const [adding, setAdding] = useState(false);
  const [rate, setRate] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState<DateKey>(todayInIsrael());

  const sorted = [...history].sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  const parsed = rate.trim() === '' ? null : Number(rate);
  const valid = parsed !== null && Number.isFinite(parsed) && parsed > 0;

  const save = () => {
    if (!valid) return;
    add.mutate(
      { role, hourlyRate: parsed, effectiveFrom },
      {
        onSuccess: () => {
          setAdding(false);
          setRate('');
        },
      },
    );
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-bold text-slate-800 dark:text-slate-100">{ROLE_LABEL[role]}</p>

      {sorted.length === 0 ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">לא הוגדר שכר עדיין.</p>
      ) : (
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
          {sorted.map((r, i) => (
            <div key={r.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <div>
                <span className="num text-sm font-bold text-slate-800 dark:text-slate-100">
                  ₪{r.hourly_rate}
                </span>
                <span className="ms-2 text-xs text-slate-500 dark:text-slate-400">
                  {i === 0 ? 'נוכחי' : 'היה'} · מ-{r.effective_from}
                </span>
              </div>
              <button
                type="button"
                onClick={() => del.mutate(r.id)}
                disabled={del.isPending}
                className="text-xs text-rose-600 hover:underline disabled:opacity-50 dark:text-rose-400"
              >
                הסרה
              </button>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <div className="flex flex-wrap items-end gap-2 rounded-xl bg-slate-50 p-2.5 dark:bg-slate-800">
          <label className="flex-1 min-w-[100px]">
            <span className="mb-1 block text-[11px] font-semibold text-slate-600 dark:text-slate-300">
              שכר חדש (₪)
            </span>
            <input
              type="number"
              min={0}
              step="0.01"
              autoFocus
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              placeholder="לדוגמה 40"
              className={cn(
                'w-full rounded-lg border-2 border-slate-200 p-1.5 text-sm text-slate-800',
                'dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100',
                'focus:border-brand-400 focus:outline-none',
                rate && !valid && 'border-rose-400',
              )}
            />
          </label>
          <label className="flex-1 min-w-[120px]">
            <span className="mb-1 block text-[11px] font-semibold text-slate-600 dark:text-slate-300">
              בתוקף מתאריך
            </span>
            <DateField value={effectiveFrom} onChange={setEffectiveFrom} />
          </label>
          <Button size="sm" disabled={!valid} loading={add.isPending} onClick={save}>
            שמירה
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
            ביטול
          </Button>
          {add.isError && <Alert tone="error">{(add.error as Error).message}</Alert>}
        </div>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
          + שכר חדש
        </Button>
      )}
    </div>
  );
}
