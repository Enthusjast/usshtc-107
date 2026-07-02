import { useState, useRef, useCallback, createContext, useContext } from 'react';

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const pushToast = useCallback((severity, summary, detail) => {
    idRef.current += 1;
    const id = idRef.current;
    const duration = severity === 'error' ? 4000 : 2600;
    setToasts((prev) => [...prev, { id, severity, summary, detail }]);

    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={pushToast}>
      {children}
      <div className="toast-container" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.severity}`}
            onClick={() => dismissToast(t.id)}
          >
            <span>{t.summary}</span>
            {t.detail && <span style={{ opacity: 0.8, fontSize: '0.8rem' }}>{t.detail}</span>}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
