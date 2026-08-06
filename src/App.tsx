import { Suspense, lazy, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { Login } from '@/pages/Login';
import { GuardHome } from '@/pages/GuardHome';
import { Preferences } from '@/pages/Preferences';
import { NotFound, RosterView } from '@/pages/Placeholders';
import { Spinner } from '@/components/ui';

/**
 * The manager dashboard is used by one person; eight guards never open it.
 * Splitting it out keeps its code (and, later, the solver UI) off the download
 * path for everyone else.
 */
const ManagerDashboard = lazy(() =>
  import('@/pages/ManagerDashboard').then((m) => ({ default: m.ManagerDashboard })),
);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function FullScreenLoader() {
  return (
    <div className="grid min-h-dvh place-items-center bg-slate-100">
      <Spinner className="size-8 text-brand-600" />
    </div>
  );
}

/** Requires a session. */
function Protected({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'signedOut') return <Navigate to="/login" replace />;
  return <>{children}</>;
}

/** Requires the manager/admin role. Note this is a UX guard only -- the real
 *  enforcement is the RLS policies, which do not trust the client at all. */
function ManagerOnly({ children }: { children: ReactNode }) {
  const { status, isManager } = useAuth();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'signedOut') return <Navigate to="/login" replace />;
  if (!isManager) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function LoginRoute() {
  const { status } = useAuth();
  if (status === 'loading') return <FullScreenLoader />;
  if (status === 'signedIn') return <Navigate to="/" replace />;
  return <Login />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route
        path="/"
        element={
          <Protected>
            <GuardHome />
          </Protected>
        }
      />
      <Route
        path="/preferences"
        element={
          <Protected>
            <Preferences />
          </Protected>
        }
      />
      <Route
        path="/roster"
        element={
          <Protected>
            <RosterView />
          </Protected>
        }
      />
      <Route
        path="/manage"
        element={
          <ManagerOnly>
            <Suspense fallback={<FullScreenLoader />}>
              <ManagerDashboard />
            </Suspense>
          </ManagerOnly>
        }
      />
      <Route
        path="*"
        element={
          <Protected>
            <NotFound />
          </Protected>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
