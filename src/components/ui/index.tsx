import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

const BUTTON_VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 shadow-sm',
  secondary:
    'bg-white text-slate-800 ring-1 ring-slate-300 hover:bg-slate-50 ' +
    'dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600 dark:hover:bg-slate-700',
  ghost:
    'bg-transparent text-slate-600 hover:bg-slate-200/70 dark:text-slate-300 dark:hover:bg-slate-700/70',
  danger: 'bg-rose-600 text-white hover:bg-rose-700',
} as const;

const BUTTON_SIZES = {
  sm: 'h-9 px-3 text-sm',
  md: 'h-11 px-4 text-[15px]',
  lg: 'h-14 px-6 text-lg',
} as const;

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors duration-150';

// ---------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={cn(
        BUTTON_BASE,
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <Spinner className="size-4" />}
      {children}
    </button>
  );
}

/**
 * Navigation styled as a button.
 *
 * Deliberately NOT `<Button><Link/></Button>`: nesting an anchor inside a
 * button is invalid HTML, breaks keyboard and screen-reader semantics, and
 * leaves the disabled state unenforced because the inner link still navigates.
 */
export function ButtonLink({
  to,
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  disabled = false,
  className,
  children,
}: {
  to: string;
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  fullWidth?: boolean;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const classes = cn(
    BUTTON_BASE,
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    fullWidth && 'w-full',
    className,
  );

  if (disabled) {
    return (
      <span aria-disabled="true" className={cn(classes, 'cursor-not-allowed opacity-50')}>
        {children}
      </span>
    );
  }
  return (
    <Link to={to} className={classes}>
      {children}
    </Link>
  );
}

// ---------------------------------------------------------------------------

export function Card({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  // Tailwind does not resolve conflicting utilities by their order in the class
  // string -- whichever lands later in the generated stylesheet wins. So an
  // unconditional `bg-white` here silently beat a caller's `bg-slate-800`, and
  // a card passing `text-white` rendered white-on-white: present, populated,
  // and completely invisible. Only apply the default when the caller has not
  // supplied a background of their own.
  const callerSetsBackground = /(^|\s)bg-/.test(className ?? '');

  return (
    <div
      className={cn(
        'rounded-card p-5 shadow-sm ring-1 ring-slate-200/80 dark:ring-slate-700/80',
        !callerSetsBackground && 'bg-white dark:bg-slate-900',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin', className ?? 'size-5')} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------

export function Badge({
  tone = 'slate',
  children,
  className,
}: {
  tone?: 'slate' | 'green' | 'amber' | 'rose' | 'brand';
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700',
    green:
      'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-400 dark:ring-emerald-800',
    amber:
      'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-800',
    rose: 'bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-400 dark:ring-rose-800',
    brand:
      'bg-brand-50 text-brand-700 ring-brand-200 dark:bg-brand-950 dark:text-brand-300 dark:ring-brand-800',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ring-1',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex items-start gap-3 rounded-xl p-3 transition-colors',
        disabled ? 'opacity-60' : 'cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-brand-600' : 'bg-slate-300 dark:bg-slate-600',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 size-5 rounded-full bg-white shadow transition-all',
            // Logical inset: `start` is the RIGHT edge under dir="rtl".
            // Off rests at the start; on slides toward the end (leftwards).
            checked ? 'start-[1.375rem]' : 'start-0.5',
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold text-slate-800 dark:text-slate-100">
          {label}
        </span>
        {description && (
          <span className="mt-0.5 block text-sm leading-snug text-slate-500 dark:text-slate-400">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------

/** A bounded +/- counter. Used for כמות everywhere it appears -- the weekly
 *  target (TeamTable) and the per-guard default (TeamManagement). */
export function Stepper({
  value,
  onChange,
  disabled,
  max = 5,
  min = 0,
}: {
  value: number;
  onChange: (v: number) => void;
  disabled?: boolean;
  max?: number;
  min?: number;
}) {
  const btn =
    'grid size-8 place-items-center rounded-lg text-lg font-bold transition-colors ' +
    'disabled:opacity-30 disabled:cursor-not-allowed';
  return (
    <div className="flex items-center gap-1">
      {/* RTL: minus sits on the right, matching the reading direction. */}
      <button
        type="button"
        disabled={disabled || value <= min}
        onClick={() => onChange(value - 1)}
        className={cn(
          btn,
          'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700',
        )}
        aria-label="הפחת"
      >
        −
      </button>
      <span className="w-7 text-center text-lg font-extrabold tabular-nums text-slate-900 dark:text-slate-100">
        {value}
      </span>
      <button
        type="button"
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
        className={cn(
          btn,
          'bg-brand-50 text-brand-700 hover:bg-brand-100 dark:bg-brand-950 dark:text-brand-300 dark:hover:bg-brand-900',
        )}
        aria-label="הוסף"
      >
        +
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function Alert({
  tone = 'info',
  title,
  children,
}: {
  tone?: 'info' | 'warn' | 'error' | 'success';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    info: 'bg-brand-50 text-brand-900 ring-brand-200 dark:bg-brand-950 dark:text-brand-200 dark:ring-brand-800',
    warn: 'bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
    error: 'bg-rose-50 text-rose-900 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-800',
    success:
      'bg-emerald-50 text-emerald-900 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800',
  };
  return (
    <div className={cn('rounded-xl px-4 py-3 text-sm ring-1', tones[tone])} role="status">
      {title && <p className="mb-0.5 font-bold">{title}</p>}
      <div className="leading-relaxed">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Generic overlay dialog -- extracted from what was a one-off `PreviewModal`
 * local to RosterExport.tsx (the roster image preview). Same behavior:
 * `fixed inset-0` backdrop, centered rounded panel, Escape-to-close,
 * click-outside-to-close, no portal, no focus trap. RosterExport.tsx keeps
 * its own copy rather than being rebased onto this -- not worth touching a
 * working, unrelated feature just to share code with a new caller.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <p className="font-bold text-slate-900 dark:text-slate-100">{title}</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            aria-label="סגירה"
          >
            <svg className="size-5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M4.3 4.3a1 1 0 0 1 1.4 0L10 8.6l4.3-4.3a1 1 0 1 1 1.4 1.4L11.4 10l4.3 4.3a1 1 0 0 1-1.4 1.4L10 11.4l-4.3 4.3a1 1 0 0 1-1.4-1.4L8.6 10 4.3 5.7a1 1 0 0 1 0-1.4Z" />
            </svg>
          </button>
        </div>
        <div className="overflow-auto p-4">{children}</div>
        {footer && (
          <div className="border-t border-slate-200 p-3 dark:border-slate-800">{footer}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      {icon && <div className="text-4xl opacity-40">{icon}</div>}
      <p className="text-lg font-bold text-slate-700 dark:text-slate-200">{title}</p>
      {description && (
        <p className="max-w-xs text-sm text-slate-500 dark:text-slate-400">{description}</p>
      )}
      {action}
    </div>
  );
}
