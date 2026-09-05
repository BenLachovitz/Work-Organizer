import { useState } from 'react';
import { Alert, Badge, Button, Collapsible, cn } from '@/components/ui';
import type { ScheduleRun } from '@/types/database';

/**
 * Every roster generated for a week, with the actions a manager needs on each.
 *
 * A published roster is NOT read-only. During the week people call in sick and
 * swap shifts; refusing to touch a live roster does not stop the change, it
 * just pushes it back to WhatsApp. So publish, unpublish, edit and delete are
 * all available — with the consequence stated where it is not obvious, because
 * editing a live roster changes what guards see on their phones.
 */
export function RunVersions({
  runs,
  selectedId,
  onSelect,
  onPublish,
  onUnpublish,
  onEdit,
  onDelete,
  busy,
  disabled,
}: {
  runs: ScheduleRun[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPublish: (id: string) => void;
  onUnpublish: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  busy: boolean;
  disabled?: boolean;
}) {
  // Deleting a roster is irreversible and cascades to its assignments, so it
  // asks once rather than relying on the button being small.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (runs.length === 0) return null;

  return (
    <Collapsible
      variant="card"
      title="גרסאות הסידור"
      summary="כל הרצה נשמרת בנפרד. אפשר לערוך, לפרסם או למחוק כל אחת - גם לאחר פרסום."
      defaultExpanded
    >
      <div className="divide-y divide-slate-100 dark:divide-slate-800">
        {runs.map((run) => {
          const selected = run.id === selectedId;
          const edited = run.solver_status.includes('+EDITED');
          return (
            <div
              key={run.id}
              className={cn('py-2.5', selected && 'bg-brand-50/40 dark:bg-brand-950/30')}
            >
              <button
                type="button"
                onClick={() => onSelect(run.id)}
                className="flex w-full items-center gap-2 text-start"
              >
                <span
                  className={cn(
                    'size-2.5 shrink-0 rounded-full',
                    selected ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="font-bold text-slate-900 dark:text-slate-100">
                    גרסה {run.version}
                  </span>
                  <span className="num ms-2 text-xs text-slate-500 dark:text-slate-400">
                    {run.solver_status.replace('+EDITED', '')}
                  </span>
                  {run.objective_value !== null && (
                    <span className="ms-2 text-xs text-slate-400 dark:text-slate-500">
                      ניקוד {run.objective_value}
                    </span>
                  )}
                </span>
                {edited && <Badge tone="amber">נערך ידנית</Badge>}
                {run.is_published && <Badge tone="green">מפורסם</Badge>}
              </button>

              {selected && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onEdit(run.id)}>
                    ערוך
                  </Button>
                  {run.is_published ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={busy}
                      disabled={disabled}
                      onClick={() => onUnpublish(run.id)}
                    >
                      בטל פרסום
                    </Button>
                  ) : (
                    <Button size="sm" loading={busy} disabled={disabled} onClick={() => onPublish(run.id)}>
                      פרסם
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant={confirmDelete === run.id ? 'danger' : 'ghost'}
                    loading={busy}
                    disabled={disabled}
                    onClick={() =>
                      confirmDelete === run.id ? onDelete(run.id) : setConfirmDelete(run.id)
                    }
                  >
                    {confirmDelete === run.id ? 'לחץ שוב למחיקה' : 'מחק'}
                  </Button>
                  {confirmDelete === run.id && (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                      ביטול
                    </Button>
                  )}
                </div>
              )}

              {selected && run.is_published && (
                <Alert tone="warn">
                  זהו הסידור שהצוות רואה כרגע בטלפון. כל עריכה או מחיקה משפיעה עליהם מיד.
                </Alert>
              )}
            </div>
          );
        })}
      </div>
    </Collapsible>
  );
}
