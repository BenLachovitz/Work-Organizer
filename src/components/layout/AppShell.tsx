import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';

// ---------------------------------------------------------------------------

function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const { profile, signOut } = useAuth();

  return (
    <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-extrabold text-slate-900">{title}</h1>
          {subtitle && <p className="truncate text-xs text-slate-500">{subtitle}</p>}
        </div>

        {profile && (
          <div className="flex items-center gap-2">
            <div className="text-end">
              <p className="text-sm font-bold text-slate-800">{profile.display_name}</p>
              <p className="num text-[11px] text-slate-400">{profile.employee_code}</p>
            </div>
            <div
              className={cn(
                'grid size-10 shrink-0 place-items-center rounded-full text-sm font-bold text-white',
                profile.role === 'guard' ? 'bg-brand-600' : 'bg-slate-800',
              )}
              title={profile.role === 'guard' ? 'מאבטח' : 'מנהל'}
            >
              {profile.display_name.slice(0, 2)}
            </div>
            <button
              onClick={() => void signOut()}
              className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
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
          </div>
        )}
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
    <nav className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-3xl">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              cn(
                'flex flex-1 flex-col items-center gap-1 py-2.5 text-[11px] font-semibold transition-colors',
                isActive ? 'text-brand-600' : 'text-slate-400 hover:text-slate-600',
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

  return (
    <div className="min-h-dvh bg-slate-100">
      <Header title={title} subtitle={subtitle} />
      <main key={pathname} className="mb-safe mx-auto max-w-3xl px-4 py-5">
        {children}
      </main>
      <BottomNav />
    </div>
  );
}
