import { Badge, Card, cn } from '@/components/ui';
import { MAX_SHIFTS_PER_WEEK } from '@/lib/shifts';
import type { GuardRow } from '@/hooks/useManager';

function Stepper({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  const btn =
    'grid size-8 place-items-center rounded-lg text-lg font-bold transition-colors ' +
    'disabled:opacity-30 disabled:cursor-not-allowed';
  return (
    <div className="flex items-center gap-1">
      {/* RTL: minus sits on the right, matching the reading direction. */}
      <button
        type="button"
        disabled={disabled || value <= 0}
        onClick={() => onChange(value - 1)}
        className={cn(btn, 'bg-slate-100 text-slate-600 hover:bg-slate-200')}
        aria-label="הפחת"
      >
        −
      </button>
      <span className="w-7 text-center text-lg font-extrabold tabular-nums text-slate-900">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled || value >= MAX_SHIFTS_PER_WEEK}
        onClick={() => onChange(value + 1)}
        className={cn(btn, 'bg-brand-50 text-brand-700 hover:bg-brand-100')}
        aria-label="הוסף"
      >
        +
      </button>
    </div>
  );
}

const STATE_BADGE = {
  filled: { tone: 'green' as const, label: 'הגיש' },
  empty: { tone: 'amber' as const, label: 'הגיש ריק' },
  none: { tone: 'rose' as const, label: 'טרם הגיש' },
};

export function TeamTable({
  rows,
  onSetKamut,
  savingGuardId,
  locked,
}: {
  rows: GuardRow[];
  onSetKamut: (guardId: string, kamut: number) => void;
  savingGuardId?: string | null;
  locked?: boolean;
}) {
  const submitted = rows.filter((r) => r.state !== 'none').length;
  const totalKamut = rows.reduce((sum, r) => sum + r.effectiveKamut, 0);

  return (
    <Card className="p-0">
      <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3">
        <div>
          <p className="font-bold text-slate-900">הצוות והכמות</p>
          <p className="mt-0.5 text-sm text-slate-500">
            {submitted} מתוך {rows.length} הגישו · סך היעדים {totalKamut}
          </p>
        </div>
      </div>

      <div className="divide-y divide-slate-100">
        {rows.map((row) => {
          const badge = STATE_BADGE[row.state];
          return (
            <div key={row.guard.id} className="px-4 py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-bold text-slate-900">
                      {row.guard.display_name}
                    </span>
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    <span className="num">{row.guard.employee_code}</span>
                    {row.state !== 'none' && (
                      <>
                        {' · '}
                        {row.availableDays} ימים זמינים · {row.slotCount} משמרות
                      </>
                    )}
                  </p>
                  {/* Day counts, not a yes/no: the opt-in is per day now, and
                      "3 days" is the number that tells a manager how much
                      extended cover is actually available. */}
                  {(row.twelveHourDayCount > 0 || row.twelveHourNightCount > 0) && (
                    <div className="mt-1.5 flex gap-1.5">
                      {row.twelveHourDayCount > 0 && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
                          style={{ backgroundColor: 'var(--color-shift-day12)' }}
                        >
                          יום 12ש׳ · {row.twelveHourDayCount} ימים
                        </span>
                      )}
                      {row.twelveHourNightCount > 0 && (
                        <span
                          className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white"
                          style={{ backgroundColor: 'var(--color-shift-night12)' }}
                        >
                          לילה 12ש׳ · {row.twelveHourNightCount} ימים
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="shrink-0 text-center">
                  <p className="mb-1 text-[10px] font-bold uppercase text-slate-400">כמות</p>
                  <Stepper
                    value={row.configuredKamut}
                    disabled={locked || savingGuardId === row.guard.id}
                    onChange={(v) => onSetKamut(row.guard.id, v)}
                  />
                </div>
              </div>

              {/* The override is shown BEFORE generation, not discovered after.
                  A manager who sets 4 for someone who marked 2 days should find
                  out here, while they can still phone them. */}
              {row.lowered && (
                <p className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  סימן {row.availableDays} ימים בלבד - היעד בפועל יהיה{' '}
                  <strong>{row.effectiveKamut}</strong> במקום {row.configuredKamut}
                </p>
              )}
              {row.state === 'none' && row.configuredKamut > 0 && (
                <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-800">
                  טרם הגיש - היעד יירד ל-0 אם לא יגיש עד מועד הסגירה
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
