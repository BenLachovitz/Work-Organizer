import { useState } from 'react';
import { Alert, Button, Collapsible, Spinner, cn } from '@/components/ui';
import { usePayrollSettings, useUpdatePayrollSettings, type PayrollSettings } from '@/hooks/useWorkLog';

/**
 * Standing, global rates for the estimated-salary feature (/worklog) --
 * one flat hourly wage for every guard, a separate one for the manager.
 * Not per-individual: everyone on the team is paid the same except the
 * manager, so there is nothing here to set per-guard (see TeamManagement
 * for actual per-guard settings like default כמות, which this is NOT one
 * of). Same standing-settings home as the scheduler defaults above it.
 */
export function PayrollRateSettings({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const { data, isLoading, error } = usePayrollSettings();

  return (
    <Collapsible
      title="שכר לשעה · יומן עבודה"
      summary={
        isLoading
          ? 'טוען…'
          : data
            ? `מאבטחים ₪${data.guard_hourly_rate ?? '—'} · מנהל ₪${data.manager_hourly_rate ?? '—'}`
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
        <RatesForm current={data} />
      )}
    </Collapsible>
  );
}

function RatesForm({ current }: { current: PayrollSettings }) {
  const update = useUpdatePayrollSettings();
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [guardRate, setGuardRate] = useState(current.guard_hourly_rate?.toString() ?? '');
  const [managerRate, setManagerRate] = useState(current.manager_hourly_rate?.toString() ?? '');

  const parse = (v: string) => (v.trim() === '' ? null : Number(v));
  const guardParsed = parse(guardRate);
  const managerParsed = parse(managerRate);
  const guardValid = guardParsed === null || (Number.isFinite(guardParsed) && guardParsed > 0);
  const managerValid = managerParsed === null || (Number.isFinite(managerParsed) && managerParsed > 0);
  const dirty = guardParsed !== current.guard_hourly_rate || managerParsed !== current.manager_hourly_rate;

  const save = () => {
    if (!guardValid || !managerValid) return;
    update.mutate(
      { guard_hourly_rate: guardParsed, manager_hourly_rate: managerParsed },
      { onSuccess: () => setSavedAt(new Date()) },
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-500 dark:text-slate-400">
        משפיע רק על הערכת השכר ב"יומן עבודה" - אינו מחובר למערכת שכר אמיתית ואינו נוגע לסידור
        המשמרות עצמו.
      </p>

      <Field label="שכר לשעה - מאבטחים (₪)" value={guardRate} onChange={setGuardRate} invalid={!guardValid} />
      <Field
        label="שכר לשעה - מנהל (₪)"
        value={managerRate}
        onChange={setManagerRate}
        invalid={!managerValid}
      />

      {update.isError && (
        <Alert tone="error">
          {update.error instanceof Error ? update.error.message : 'השמירה נכשלה.'}
        </Alert>
      )}
      {savedAt && !dirty && <Alert tone="success">נשמר בהצלחה.</Alert>}

      <Button
        fullWidth
        size="sm"
        disabled={!dirty || !guardValid || !managerValid}
        loading={update.isPending}
        onClick={save}
      >
        שמירה
      </Button>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold text-slate-700 dark:text-slate-300">
        {label}
      </span>
      <input
        type="number"
        min={0}
        step="0.01"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="לדוגמה 35"
        className={cn(
          'w-full rounded-xl border-2 border-slate-200 p-2.5 text-sm text-slate-800',
          'dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100',
          'focus:border-brand-400 focus:outline-none',
          invalid && 'border-rose-400',
        )}
      />
    </label>
  );
}
