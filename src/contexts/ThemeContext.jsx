import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { getTheme, setTheme as persistTheme, onThemeChanged } from '../lib/electron';

const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('dark');

  useEffect(() => {
    getTheme().then((t) => {
      if (t) {
        setThemeState(t);
        document.documentElement.setAttribute('data-theme', t);
      }
    });
  }, []);

  useEffect(() => {
    const unsub = onThemeChanged((t) => {
      setThemeState(t);
      document.documentElement.setAttribute('data-theme', t);
    });
    return () => unsub?.();
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    persistTheme(next);
  }, [theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
