import { useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import {
  WeeklyPreferenceForm,
  rowsToSelection,
  selectionToSlots,
  type PreferenceFormValue,
} from '@/components/guard/WeeklyPreferenceForm';
import { Alert, Card, Spinner } from '@/components/ui';
import { useActiveWeek } from '@/hooks/useWeeks';
import { useGuardWeek, useSavePreferences } from '@/hooks/useGuardPortal';
import { formatWeekRange, submissionDeadline } from '@/lib/dates';

export function Preferences() {
  const { data: active, isLoading: weekLoading } = useActiveWeek();
  const { data: guardWeek, isLoading: dataLoading, error } = useGuardWeek(active.weekStart);
  const save = useSavePreferences();

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  // Clear the confirmation when the guard edits again, so a stale "saved"
  // banner can never sit above unsaved changes.
  useEffect(() => {
    if (save.isPending) setSavedAt(null);
  }, [save.isPending]);

  // The submit button sits at the bottom of what can be a long form, but the
  // confirmation banner renders at the top -- without this, a guard who just
  // submitted stays scrolled down past it and never sees it saved.
  // scrollIntoView finds whichever ancestor actually scrolls (AppShell's
  // <main>) on its own; no need to know that structure from here.
  useEffect(() => {
    if (savedAt) topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [savedAt]);

  const loading = weekLoading || dataLoading;

  const handleSubmit = (value: PreferenceFormValue) => {
    save.mutate(
      { weekStart: active.weekStart, slots: selectionToSlots(value.slots), notes: value.notes },
      { onSuccess: () => setSavedAt(new Date()) },
    );
  };

  if (loading) {
    return (
      <AppShell title="הגשת בקשות">
        <div className="grid place-items-center py-20">
          <Spinner className="size-7 text-brand-600" />
        </div>
      </AppShell>
    );
  }

  if (error) {
    return (
      <AppShell title="הגשת בקשות">
        <Alert tone="error" title="שגיאה בטעינת הנתונים">
          {error instanceof Error ? error.message : 'נסה לרענן את הדף.'}
        </Alert>
      </AppShell>
    );
  }

  if (!active.week) {
    return (
      <AppShell title="הגשת בקשות">
        <Card>
          <p className="font-bold text-slate-900">אין כרגע שבוע פתוח להגשה</p>
          <p className="mt-1 text-sm text-slate-500">
            עדיין לא נפתח שבוע חדש להגשה, או שכל חלונות ההגשה נסגרו. נסה שוב מאוחר יותר.
          </p>
        </Card>
      </AppShell>
    );
  }

  const deadline = active.deadline ?? submissionDeadline(active.weekStart);

  const initial: PreferenceFormValue = {
    slots: rowsToSelection(guardWeek?.preferences ?? []),
    notes: guardWeek?.submission?.notes ?? '',
  };

  return (
    <AppShell title="הגשת בקשות" subtitle={formatWeekRange(active.weekStart)}>
      <div ref={topRef} className="space-y-4">
        {guardWeek?.hasSubmitted && !savedAt && (
          <Alert tone="success" title="הבקשות שלך נשמרו">
            {guardWeek.preferences.length === 0
              ? 'הגשת שבוע ריק - לא תשובץ למשמרות. אפשר לשנות עד מועד הסגירה.'
              : `${guardWeek.preferences.length} משמרות סומנו. אפשר לערוך עד מועד הסגירה.`}
          </Alert>
        )}

        {savedAt && (
          <Alert tone="success" title="נשמר בהצלחה">
            הבקשות עודכנו בשעה{' '}
            {savedAt.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}.
          </Alert>
        )}

        {save.isError && (
          <Alert tone="error" title="השמירה נכשלה">
            {save.error instanceof Error ? save.error.message : 'נסה שוב.'}
          </Alert>
        )}

        {/* Keyed so the form re-initialises from the server after a refetch --
            useState initialisers do not re-run on prop change. */}
        <WeeklyPreferenceForm
          key={`${active.weekStart}:${guardWeek?.submission?.updated_at ?? 'new'}`}
          weekStart={active.weekStart}
          deadline={deadline}
          locked={!active.isOpen}
          configuredKamut={guardWeek?.target?.configured_kamut ?? 0}
          initial={initial}
          onSubmit={handleSubmit}
          submitting={save.isPending}
        />
      </div>
    </AppShell>
  );
}
