import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { DEFAULT_SCHEME_ID, SCHEMES, STORAGE_KEY, isSchemeId } from '@/theme/schemes';

interface ThemeContextValue {
  scheme: string;
  setScheme: (id: string) => void;
  schemes: typeof SCHEMES;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialScheme(): string {
  const fromDom = document.documentElement.getAttribute('data-theme');
  if (isSchemeId(fromDom)) {
    return fromDom;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isSchemeId(stored)) {
      return stored;
    }
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_SCHEME_ID;
}

interface ThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: ThemeProviderProps) {
  const [scheme, setSchemeState] = useState(readInitialScheme);

  useEffect(() => {
    const el = document.documentElement;
    el.setAttribute('data-theme', scheme);
    el.classList.add('dark');
    try {
      localStorage.setItem(STORAGE_KEY, scheme);
    } catch {
      /* localStorage unavailable */
    }
  }, [scheme]);

  const setScheme = useCallback((id: string) => {
    if (isSchemeId(id)) {
      setSchemeState(id);
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ scheme, setScheme, schemes: SCHEMES }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (ctx === null) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}
