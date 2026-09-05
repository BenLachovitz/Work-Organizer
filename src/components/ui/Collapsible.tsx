import { useState, type ReactNode } from 'react';
import { Card, cn } from './index';

/**
 * Shared expand/collapse section, replacing three previously independent
 * hand-rolled copies (DefaultMorningTargetSettings, SubmissionWindowSettings,
 * and WeekControlsPanel's per-day-override toggle). Two variants preserve
 * each of those exact prior visual treatments:
 *
 *   "card"  -- a full Card wrapper with a border-t divider above the content,
 *              for a standalone settings section.
 *   "plain" -- a bare button+chevron with no card wrapper, for a toggle
 *              nested inside a caller's own Card.
 */
export function Collapsible({
  variant = 'card',
  title,
  summary,
  defaultExpanded = false,
  bodyClassName = 'px-4 py-3',
  children,
}: {
  variant?: 'card' | 'plain';
  title: ReactNode;
  summary?: ReactNode;
  defaultExpanded?: boolean;
  /** Card variant only. Content that already manages its own internal
   *  padding (a table, a divide-y row list) should pass "" here to avoid
   *  doubling up with this wrapper's own padding. */
  bodyClassName?: string;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  const header = (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className={cn(
        'flex w-full items-center justify-between text-start',
        variant === 'card' && 'px-4 py-3',
      )}
    >
      {variant === 'plain' ? (
        <span className="text-sm font-bold text-slate-700 dark:text-slate-300">{title}</span>
      ) : (
        <div>
          <p className="font-bold text-slate-900 dark:text-slate-100">{title}</p>
          {summary && (
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{summary}</p>
          )}
        </div>
      )}
      <span
        className={cn(
          'shrink-0 text-slate-400 transition-transform dark:text-slate-500',
          expanded && 'rotate-180',
        )}
      >
        ▾
      </span>
    </button>
  );

  if (variant === 'plain') {
    return (
      <div>
        {header}
        {expanded && <div className="mt-2">{children}</div>}
      </div>
    );
  }

  return (
    <Card className="p-0">
      {header}
      {expanded && (
        <div className={cn('border-t border-slate-200 dark:border-slate-800', bodyClassName)}>
          {children}
        </div>
      )}
    </Card>
  );
}
