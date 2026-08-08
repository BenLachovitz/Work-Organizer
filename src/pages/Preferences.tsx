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
import { useDeleteSubmission, useGuardWeek, useSavePreferences } from '@/hooks/useGuardPortal';
import { formatWeekRange, submissionDeadline } from '@/lib/dates';

export function Preferences() {
  const { data: active, isLoading: weekLoading } = useActiveWeek();
  const { data: guardWeek, isLoading: dataLoading, error } = useGuardWeek(active.weekStart);
  const save = useSavePreferences();
  const del = useDeleteSubmission();

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [deletedAt, setDeletedAt] = useState<Date | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  // Clear both confirmations when the guard acts again, so a stale banner
  // can never sit above the result of a newer action.
  useEffect(() => {
    if (save.isPending || del.isPending) {
      setSavedAt(null);
      setDeletedAt(null);
    }
  }, [save.isPending, del.isPending]);

  // The submit/cancel buttons sit at the bottom of what can be a long form,
  // but the confirmation banner renders at the top -- without this, a guard
  // who just acted stays scrolled down past it and never sees the result.
  // scrollIntoView finds whichever ancestor actually scrolls (AppShell's
  // <main>) on its own; no need to know that structure from here.
  useEffect(() => {
    if (savedAt || deletedAt) topRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [savedAt, deletedAt]);

  const loading = weekLoading || dataLoading;

  const handleSubmit = (value: PreferenceFormValue) => {
    save.mutate(
      { weekStart: active.weekStart, slots: selectionToSlots(value.slots), notes: value.notes },
      { onSuccess: () => setSavedAt(new Date()) },
    );
  };

  const handleDelete = () => {
    del.mutate(active.weekStart, { onSuccess: () => setDeletedAt(new Date()) });
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
        {guardWeek?.hasSubmitted && !savedAt && !deletedAt && (
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

        {deletedAt && (
          <Alert tone="info" title="ההגשה בוטלה">
            אפשר להגיש מחדש בכל עת עד מועד הסגירה.
          </Alert>
        )}

        {save.isError && (
          <Alert tone="error" title="השמירה נכשלה">
            {save.error instanceof Error ? save.error.message : 'נסה שוב.'}
          </Alert>
        )}

        {del.isError && (
          <Alert tone="error" title="ביטול ההגשה נכשל">
            {del.error instanceof Error ? del.error.message : 'נסה שוב.'}
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
          hasSubmitted={guardWeek?.hasSubmitted ?? false}
          onSubmit={handleSubmit}
          submitting={save.isPending}
          onDelete={handleDelete}
          deleting={del.isPending}
        />
      </div>
    </AppShell>
  );
}
