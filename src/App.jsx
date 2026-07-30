import { useState, useCallback, useEffect, useRef } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import { ToastProvider, useToast } from './components/Toast';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { LocaleProvider, useLocale } from './i18n/LocaleContext';
import DashboardView from './views/DashboardView';
import SessionsView from './views/SessionsView';
import LogsView from './views/LogsView';
import SettingsView from './views/SettingsView';
import { IconMenu } from './components/Icons';
import { setAppDirty } from './lib/electron';

const NARROW_VIEWPORT_MAX = 700;

const VIEWS = {
  dashboard: { component: DashboardView, key: 'dashboard' },
  sessions: { component: SessionsView, key: 'sessions' },
  logs: { component: LogsView, key: 'logs' },
  settings: { component: SettingsView, key: 'settings' },
};

function isNarrowViewport() {
  return typeof window !== 'undefined' && window.innerWidth <= NARROW_VIEWPORT_MAX;
}

function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale, t } = useLocale();
  const pushToast = useToast();
  const [activeView, setActiveView] = useState('dashboard');
  const [narrowViewport, setNarrowViewport] = useState(isNarrowViewport);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isNarrowViewport);
  const [topbarCompact, setTopbarCompact] = useState(false);
  const [viewDirty, setViewDirty] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const mainRef = useRef(null);
  const titleRef = useRef(null);
  const initialViewRef = useRef(true);
  const narrowViewportRef = useRef(narrowViewport);

  // Topbar compact on scroll
  const handleContentScroll = useCallback((e) => {
    setTopbarCompact(e.target.scrollTop > 20);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'zh' ? 'en' : 'zh');
  }, [locale, setLocale]);

  const handleNavigate = useCallback((nextView) => {
    if (nextView === activeView) {
      if (narrowViewport) setSidebarCollapsed(true);
      return;
    }
    if (viewBusy) {
      pushToast('info', t('operationInProgress'), t('waitForCurrentOperation'));
      return;
    }
    if (viewDirty && !window.confirm(t('discardUnsavedChanges'))) return;
    setViewDirty(false);
    setViewBusy(false);
    setActiveView(nextView);
    if (narrowViewport) setSidebarCollapsed(true);
  }, [activeView, narrowViewport, pushToast, t, viewBusy, viewDirty]);

  useEffect(() => {
    const syncViewport = () => {
      const nextNarrow = isNarrowViewport();
      if (nextNarrow === narrowViewportRef.current) return;
      narrowViewportRef.current = nextNarrow;
      setNarrowViewport(nextNarrow);
      setSidebarCollapsed(nextNarrow);
    };
    window.addEventListener('resize', syncViewport);
    return () => window.removeEventListener('resize', syncViewport);
  }, []);

  useEffect(() => {
    if (!narrowViewport || sidebarCollapsed) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSidebarCollapsed(true);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [narrowViewport, sidebarCollapsed]);

  useEffect(() => {
    if (initialViewRef.current) {
      initialViewRef.current = false;
      return;
    }
    if (mainRef.current) mainRef.current.scrollTop = 0;
    setTopbarCompact(false);
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeView]);

  useEffect(() => {
    void setAppDirty(viewDirty).catch(() => {});
  }, [viewDirty]);

  const ActiveComponent = VIEWS[activeView].component;
  const title = t(VIEWS[activeView].key);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t('skipToContent')}</a>
      <Sidebar
        activeView={activeView}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        theme={theme}
        onToggleTheme={toggleTheme}
        locale={locale}
        onToggleLocale={toggleLocale}
        t={t}
      />
      {narrowViewport && !sidebarCollapsed && (
        <button
          type="button"
          className="sidebar-backdrop"
          onClick={() => setSidebarCollapsed(true)}
          aria-label={t('closeSidebar')}
        />
      )}

      <div className="content-shell">
        {/* Topbar */}
        <header className={`topbar ${topbarCompact ? 'topbar--compact' : ''}`}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setSidebarCollapsed((v) => !v)}
            style={{ marginRight: '0.75rem' }}
            title={t('toggleSidebar')}
            aria-label={t('toggleSidebar')}
            aria-expanded={!sidebarCollapsed}
            aria-controls="primary-navigation"
          >
            <IconMenu size={18} />
          </button>
          <h1 ref={titleRef} className="topbar-title" tabIndex={-1}>{title}</h1>
        </header>

        {/* Page content */}
        <main id="main-content" ref={mainRef} className="page-content" onScroll={handleContentScroll} tabIndex={-1}>
          <ActiveComponent onDirtyChange={setViewDirty} onBusyChange={setViewBusy} />
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <LocaleProvider>
      <ThemeProvider>
        <ToastProvider>
          <ErrorBoundary>
            <AppShell />
          </ErrorBoundary>
        </ToastProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
