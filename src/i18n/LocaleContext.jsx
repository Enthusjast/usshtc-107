import { createContext, useContext, useState, useCallback } from 'react';
import en from './en';
import zh from './zh';

const LOCALES = { en, zh };
const FALLBACK = 'en';

const LocaleContext = createContext(null);

/**
 * Resolve a translation key — supports plain strings, functions, and dot-path access.
 * Usage: t('auth.login') or t('nCookies', 3) or t('listeningOn', '127.0.0.1', 2222)
 */
function resolve(obj, path) {
  const keys = path.split('.');
  let val = obj;
  for (const k of keys) {
    if (val == null) return null;
    val = val[k];
  }
  return val;
}

export function LocaleProvider({ children }) {
  const [locale, setLocaleState] = useState(() => {
    // Try stored preference, then browser language, fallback to 'en'
    try {
      const stored = localStorage.getItem('usshtc107-locale');
      if (stored && LOCALES[stored]) return stored;
    } catch (_) {}
    const browserLang = (navigator.language || '').toLowerCase();
    return browserLang.startsWith('zh') ? 'zh' : 'en';
  });

  const setLocale = useCallback((l) => {
    if (LOCALES[l]) {
      setLocaleState(l);
      try { localStorage.setItem('usshtc107-locale', l); } catch (_) {}
    }
  }, []);

  /**
   * Translation function. Usage:
   *   t('key')              → plain string
   *   t('key', arg1, arg2)  → function with args
   *   t('parent.child')     → nested key (dot-path)
   */
  const t = useCallback((key, ...args) => {
    const dict = LOCALES[locale] || LOCALES[FALLBACK];
    // Try dot-path first, then flat key
    let val = resolve(dict, key);
    if (val == null) {
      // Fallback to English for missing keys
      val = resolve(LOCALES[FALLBACK], key);
    }
    if (val == null) return key; // key itself as last resort

    if (typeof val === 'function') return val(...args);
    return val;
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale() {
  return useContext(LocaleContext);
}
