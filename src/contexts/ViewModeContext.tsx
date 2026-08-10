import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { ViewMode } from '@/lib/viewMode';

interface ViewModeValue {
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
}

const ViewModeContext = createContext<ViewModeValue | null>(null);

const STORAGE_KEY = 'wo.viewMode';

function readStoredViewMode(): ViewMode {
  return localStorage.getItem(STORAGE_KEY) === 'test' ? 'test' : 'real';
}

export function ViewModeProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewModeState] = useState<ViewMode>(readStoredViewMode);

  const setViewMode = useCallback((next: ViewMode) => {
    setViewModeState(next);
    // 'real' is the default, so nothing stored means "real" -- writing it
    // explicitly would be indistinguishable from an actual choice.
    if (next === 'real') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const value = useMemo<ViewModeValue>(
    () => ({ viewMode, setViewMode }),
    [viewMode, setViewMode],
  );

  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
}

export function useViewMode(): ViewModeValue {
  const ctx = useContext(ViewModeContext);
  if (!ctx) throw new Error('useViewMode must be used inside <ViewModeProvider>');
  return ctx;
}
