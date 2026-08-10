import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme, type Theme } from '@/contexts/ThemeContext';

// ---------------------------------------------------------------------------

/** Cycles system -> light -> dark -> system. The icon reflects the current
 *  PICK, not the resolved theme -- 'system' always shows the auto glyph even
 *  when it currently resolves to dark, so the control communicates what will
 *  happen on the next OS change, not just the current pixels. */
const THEME_CYCLE: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_LABEL: Record<Theme, string> = { system: 'ערכת נושא: אוטומטי', light: 'ערכת נושא: בהיר', dark: 'ערכת נושא: כהה' };

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={() => setTheme(THEME_CYCLE[theme])}
      className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
      aria-label={THEME_LABEL[theme]}
      title={THEME_LABEL[theme]}
    >
      {theme === 'light' && (
        <svg className="size-5" viewBox="0 0 24 24" fill="none" strokeWidth="2">
          <circle cx="12" cy="12" r="4" stroke="currentColor" />
          <path
            d="M12 2v2m0 16v2M4.2 4.2l1.4 1.4m12.8 12.8 1.4 1.4M2 12h2m16 0h2M4.2 19.8l1.4-1.4m12.8-12.8 1.4-1.4"
            stroke="currentColor"
            strokeLinecap="round"
          />
        </svg>
      )}
      {theme === 'dark' && (
        <svg className="size-5" viewBox="0 0 24 24" fill="none" strokeWidth="2">
          <path
            d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {theme === 'system' && (
        <svg className="size-5" viewBox="0 0 24 24" fill="none" strokeWidth="2">
          <rect x="3" y="4" width="18" height="13" rx="2" stroke="currentColor" />
          <path d="M8 21h8M12 17v4" stroke="currentColor" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const { profile, signOut } = useAuth();

  return (
    <header className="shrink-0 border-b border-slate-200 bg-white/85 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/85">
      <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-extrabold text-slate-900 dark:text-slate-50">
            {title}
          </h1>
          {subtitle && (
            <p className="truncate text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <ThemeToggle />

          {profile && (
            <>
              <div className="text-end">
                <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                  {profile.display_name}
                </p>
                <p className="num text-[11px] text-slate-400 dark:text-slate-500">
                  {profile.employee_code}
                </p>
              </div>
              <div
                className={cn(
                  'grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold text-white',
                  profile.role === 'guard' ? 'bg-brand-600' : 'bg-slate-800 dark:bg-slate-700',
                )}
                title={profile.role === 'guard' ? 'מאבטח' : 'מנהל'}
              >
                {profile.display_name.slice(0, 2)}
              </div>
              <button
                onClick={() => void signOut()}
                className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-500 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                aria-label="התנתקות"
                title="התנתקות"
              >
                <svg className="size-5" viewBox="0 0 24 24" fill="none" strokeWidth="2">
                  <path
                    d="M15 17v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v2M19 12H9m10 0-3-3m3 3-3 3"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  managerOnly?: boolean;
}

const NAV: NavItem[] = [
  {
    to: '/',
    label: 'הסידור שלי',
    icon: (
      <path
        d="M8 2v3m8-3v3M3.5 9h17M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    to: '/preferences',
    label: 'הגשת בקשות',
    icon: (
      <path
        d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    to: '/roster',
    label: 'סידור שבועי',
    icon: (
      <path
        d="M4 5h16M4 12h16M4 19h16"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
  {
    to: '/manage',
    label: 'ניהול',
    managerOnly: true,
    icon: (
      <path
        d="M10.3 3.6a1.5 1.5 0 0 1 3.4 0l.2.9a7.5 7.5 0 0 1 1.7 1l.9-.3a1.5 1.5 0 0 1 1.7 2.3l-.5.8q.2.9 0 1.8l.5.8a1.5 1.5 0 0 1-1.7 2.3l-.9-.3a7.5 7.5 0 0 1-1.7 1l-.2.9a1.5 1.5 0 0 1-3.4 0l-.2-.9a7.5 7.5 0 0 1-1.7-1l-.9.3a1.5 1.5 0 0 1-1.7-2.3l.5-.8a7.5 7.5 0 0 1 0-1.8l-.5-.8a1.5 1.5 0 0 1 1.7-2.3l.9.3q.8-.6 1.7-1ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    ),
  },
];

function BottomNav() {
  const { profile } = useAuth();
  const isManager = profile?.role === 'manager' || profile?.role === 'admin';
  const items = NAV.filter((i) => !i.managerOnly || isManager);

  return (
    <nav className="pb-safe shrink-0 border-t border-slate-200 bg-white/95 backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95">
      <div className="mx-auto flex max-w-3xl">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors',
                isActive
                  ? 'text-brand-600 dark:text-brand-400'
                  : 'text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300',
              )
            }
          >
            {({ isActive }) => (
              <>
                <svg
                  className={cn('size-6 transition-transform', isActive && 'scale-110')}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                >
                  {item.icon}
                </svg>
                <span>{item.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

// ---------------------------------------------------------------------------

export function AppShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const { pathname } = useLocation();

  // A flex column filling exactly the viewport height, not a page that
  // scrolls as a whole under a `position: fixed` header/nav. The fixed
  // approach fought the mobile browser's own dynamic toolbar: when it
  // shows or hides mid-scroll, the visual viewport height changes, and a
  // `fixed` element's position can resettle a beat later than the page's
  // own scroll position does -- which read as the bottom nav jumping and
  // landing on top of content, sometimes leaving the page unable to
  // scroll the last bit further. Here only <main> scrolls; Header and
  // BottomNav are ordinary flex children that can never be out of sync
  // with it, because nothing is independently anchored to the viewport.
  return (
    <div className="flex h-dvh flex-col bg-slate-100 dark:bg-slate-950">
      <Header title={title} subtitle={subtitle} />
      <main key={pathname} className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-5">{children}</div>
      </main>
      <BottomNav />
    </div>
  );
}
