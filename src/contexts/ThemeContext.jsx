import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { getTheme, setTheme as persistTheme, onThemeChanged } from '../lib/electron';

const ThemeContext = createContext(null);
const VALID_THEMES = new Set(['dark', 'light']);

export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState('dark');
  const themeVersionRef = useRef(0);

  const applyTheme = useCallback((nextTheme) => {
    if (!VALID_THEMES.has(nextTheme)) return false;
    themeVersionRef.current += 1;
    setThemeState(nextTheme);
    document.documentElement.setAttribute('data-theme', nextTheme);
    return true;
  }, []);

  useEffect(() => {
    let active = true;
    const themeVersionAtStart = themeVersionRef.current;
    document.documentElement.setAttribute('data-theme', 'dark');
    getTheme()
      .then((storedTheme) => {
        if (active && themeVersionRef.current === themeVersionAtStart) applyTheme(storedTheme);
      })
      .catch(() => {});
    return () => { active = false; };
  }, [applyTheme]);

  useEffect(() => {
    const unsub = onThemeChanged(applyTheme);
    return () => unsub?.();
  }, [applyTheme]);

  const toggleTheme = useCallback(async () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    const revision = ++themeVersionRef.current;
    const result = await persistTheme(next);
    if (result?.cancelled || revision !== themeVersionRef.current) return false;
    return applyTheme(next);
  }, [applyTheme, theme]);

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
