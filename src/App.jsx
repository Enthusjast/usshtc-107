import { useState, useCallback } from 'react';
import ErrorBoundary from './components/ErrorBoundary';
import Sidebar from './components/Sidebar';
import { ToastProvider } from './components/Toast';
import { ThemeProvider, useTheme } from './contexts/ThemeContext';
import { LocaleProvider, useLocale } from './i18n/LocaleContext';
import DashboardView from './views/DashboardView';
import SessionsView from './views/SessionsView';
import LogsView from './views/LogsView';
import SettingsView from './views/SettingsView';
import { IconMenu } from './components/Icons';

const VIEWS = {
  dashboard: { component: DashboardView, key: 'dashboard' },
  sessions: { component: SessionsView, key: 'sessions' },
  logs: { component: LogsView, key: 'logs' },
  settings: { component: SettingsView, key: 'settings' },
};

function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale, t } = useLocale();
  const [activeView, setActiveView] = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [topbarCompact, setTopbarCompact] = useState(false);

  // Topbar compact on scroll
  const handleContentScroll = useCallback((e) => {
    setTopbarCompact(e.target.scrollTop > 20);
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'zh' ? 'en' : 'zh');
  }, [locale, setLocale]);

  const ActiveComponent = VIEWS[activeView].component;
  const title = t(VIEWS[activeView].key);

  return (
    <div className="app-shell">
      <Sidebar
        activeView={activeView}
        onNavigate={setActiveView}
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((v) => !v)}
        theme={theme}
        onToggleTheme={toggleTheme}
        locale={locale}
        onToggleLocale={toggleLocale}
        t={t}
      />

      <div className="content-shell">
        {/* Topbar */}
        <div className={`topbar ${topbarCompact ? 'topbar--compact' : ''}`}>
          <button
            className="btn btn-sm"
            onClick={() => setSidebarCollapsed((v) => !v)}
            style={{ marginRight: '0.75rem' }}
            title={t('toggleSidebar')}
            aria-label={t('toggleSidebar')}
            aria-expanded={!sidebarCollapsed}
          >
            <IconMenu size={18} />
          </button>
          <span className="topbar-title">{title}</span>
        </div>

        {/* Page content */}
        <div className="page-content" onScroll={handleContentScroll}>
          <ActiveComponent />
        </div>
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
