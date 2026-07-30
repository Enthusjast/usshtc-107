import { useState, useRef, useCallback, createContext, useContext, useEffect } from 'react';
import { useLocale } from '../i18n/LocaleContext';

const ToastContext = createContext(null);
const MAX_TOASTS = 5;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);
  const { t } = useLocale();

  const pushToast = useCallback((severity, summary, detail) => {
    idRef.current += 1;
    const id = idRef.current;
    const duration = severity === 'error' ? 7000 : 4000;
    setToasts((prev) => [...prev, { id, severity, summary, detail }].slice(-MAX_TOASTS));
    return { id, duration };
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={pushToast}>
      {children}
      <div className="toast-container">
        {toasts.map((toast) => (
          <Toast
            key={toast.id}
            toast={toast}
            dismissLabel={t('dismissNotification')}
            onDismiss={dismissToast}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ toast, dismissLabel, onDismiss }) {
  const timerRef = useRef(null);
  const startedAtRef = useRef(0);
  const remainingRef = useRef(0);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const duration = toast.severity === 'error' ? 7000 : 4000;

  const pauseTimer = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
  }, []);

  const startTimer = useCallback(() => {
    if (timerRef.current || hoveredRef.current || focusedRef.current) return;
    startedAtRef.current = Date.now();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      remainingRef.current = 0;
      onDismiss(toast.id);
    }, remainingRef.current);
  }, [onDismiss, toast.id]);

  useEffect(() => {
    remainingRef.current = duration;
    startTimer();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [duration, startTimer]);

  const handleMouseEnter = () => {
    hoveredRef.current = true;
    pauseTimer();
  };

  const handleMouseLeave = () => {
    hoveredRef.current = false;
    startTimer();
  };

  const handleFocus = () => {
    focusedRef.current = true;
    pauseTimer();
  };

  const handleBlur = (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    focusedRef.current = false;
    startTimer();
  };

  return (
    <div
      className={`toast toast-${toast.severity}`}
      role={toast.severity === 'error' ? 'alert' : 'status'}
      aria-live={toast.severity === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocus={handleFocus}
      onBlur={handleBlur}
    >
      <div className="toast-content">
        <span>{toast.summary}</span>
        {toast.detail && <span className="toast-detail">{toast.detail}</span>}
      </div>
      <button
        type="button"
        className="toast-close"
        aria-label={dismissLabel}
        onClick={() => onDismiss(toast.id)}
      >
        &times;
      </button>
    </div>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
