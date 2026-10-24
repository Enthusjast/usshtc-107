import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import en from './en';
import zh from './zh';
import { getStatus, getSettings, onRuntimeState, setAppLocale } from '../lib/electron';

const LOCALES = { en, zh };
const FALLBACK = 'en';

const LocaleContext = createContext(null);

/**
 * Resolve a translation key — supports plain strings, functions, and dot-path access.
 * Usage: t('auth.login') or t('nCookies', 3) or t('listeningOn', '127.0.0.1', 3000)
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
  const [locale, setLocaleState] = useState(FALLBACK);
  const preferenceRevision = useRef(0);

  useEffect(() => {
    let active = true;
    let latestScope = null;
    let latestRevision = -1;
    let readSequence = 0;
    const readPreferences = async (snapshot) => {
      if (!active || !snapshot || snapshot.revision <= latestRevision) return;
      latestRevision = snapshot.revision;
      const scope = { profileId: snapshot.profileId, epoch: snapshot.epoch };
      if (latestScope?.profileId === scope.profileId && latestScope?.epoch === scope.epoch) return;
      latestScope = scope;
      const sequence = ++readSequence;
      const revision = preferenceRevision.current;
      try {
        const settings = await getSettings(scope);
        if (active && sequence === readSequence && revision === preferenceRevision.current && LOCALES[settings.locale]) {
          setLocaleState(settings.locale);
        }
      } catch (_) { /* Keep the safe fallback without persisting it. */ }
    };
    let unsubscribe;
    try { unsubscribe = onRuntimeState((value) => { void readPreferences(value); }); } catch (_) {}
    void getStatus().then(readPreferences).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);

  const setLocale = useCallback(async (nextLocale) => {
    if (!LOCALES[nextLocale]) return;
    const revision = ++preferenceRevision.current;
    const result = await setAppLocale(nextLocale);
    if (!result?.cancelled && revision === preferenceRevision.current) setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale]);

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
