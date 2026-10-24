import { formatApiError } from './lib/api-errors';
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
import DiagnosticsView from './views/DiagnosticsView';
import SetupView from './views/SetupView';
import { IconMenu } from './components/Icons';
import { RuntimeProvider, useRuntime } from './contexts/RuntimeContext';
import { ProfileProvider, useProfiles } from './contexts/ProfileContext';
import { retryLoadSettings } from './lib/electron';
import { UpdateProvider } from './contexts/UpdateContext';
import UpdateBanner from './components/UpdateBanner';

const NARROW_VIEWPORT_MAX = 700;

const VIEWS = {
  dashboard: { component: DashboardView, key: 'dashboard' },
  sessions: { component: SessionsView, key: 'sessions' },
  logs: { component: LogsView, key: 'logs' },
  diagnostics: { component: DiagnosticsView, key: 'diagnostics' },
  settings: { component: SettingsView, key: 'settings' },
  setup: { component: SetupView, key: 'setupTitle' },
};

function isNarrowViewport() {
  return typeof window !== 'undefined' && window.innerWidth <= NARROW_VIEWPORT_MAX;
}

function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const { locale, setLocale, t } = useLocale();
  const pushToast = useToast();
  const { snapshot, scope, reportDraft, error: runtimeError, retry } = useRuntime();
  const { data: profiles, error: profileError, pending: profilePending, reload: reloadProfiles, run: runProfile } = useProfiles();
  const [retryingStorage, setRetryingStorage] = useState(false);
  const handleDraftChange = useCallback((draft) => {
    setViewDirty(draft.dirty);
    void reportDraft(draft).catch((error) => pushToast('error', t('actionFailed'), formatApiError(error, t)));
  }, [reportDraft, pushToast, t]);
  const [activeView, setActiveView] = useState('dashboard');
  const [settingsSection, setSettingsSection] = useState('');
  const [narrowViewport, setNarrowViewport] = useState(isNarrowViewport);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(isNarrowViewport);
  const [topbarCompact, setTopbarCompact] = useState(false);
  const [viewDirty, setViewDirty] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const mainRef = useRef(null);
  const titleRef = useRef(null);
  const initialViewRef = useRef(true);
  const narrowViewportRef = useRef(narrowViewport);
  const activationRef = useRef({ profileId: null, awaitingProfiles: true });
  const sidebarRef = useRef(null);
  const drawerTriggerRef = useRef(null);
  const drawerOpen = narrowViewport && !sidebarCollapsed;
  const toggleSidebar = (event) => {
    if (sidebarCollapsed) drawerTriggerRef.current = event.currentTarget;
    setSidebarCollapsed((value) => !value);
  };

  // Topbar compact on scroll
  const handleContentScroll = useCallback((e) => {
    setTopbarCompact(e.target.scrollTop > 20);
  }, []);

  const toggleLocale = useCallback(async () => {
    try { await setLocale(locale === 'zh' ? 'en' : 'zh'); }
    catch (error) { pushToast('error', t('actionFailed'), formatApiError(error, t)); }
  }, [locale, setLocale, pushToast, t]);

  const handleToggleTheme = async () => {
    try { await toggleTheme(); }
    catch (error) { pushToast('error', t('actionFailed'), formatApiError(error, t)); }
  };
  const handleActivateProfile = async (id) => {
    if (id === scope?.profileId || viewBusy) return;
    try {
      await runProfile('activate', { id });
    } catch (error) {
      pushToast('error', t('profileActionFailed'), formatApiError(error, t));
    }
  };

  const handleRetryStorage = async () => {
    setRetryingStorage(true);
    try {
      const result = await retryLoadSettings(scope);
      if (!result?.cancelled) { await retry(); await reloadProfiles(); }
    } catch (error) { pushToast('error', t('actionFailed'), formatApiError(error, t)); }
    finally { setRetryingStorage(false); }
  };

  const handleNavigate = useCallback((nextView, section = '') => {
    if (nextView === activeView && !section) {
      if (narrowViewport) setSidebarCollapsed(true);
      return;
    }
    if (viewBusy || profilePending || snapshot?.operation) {
      pushToast('info', t('operationInProgress'), t('waitForCurrentOperation'));
      return;
    }
    if (nextView === activeView) {
      setSettingsSection(section);
      requestAnimationFrame(() => {
        const heading = document.getElementById(`${section}-heading`);
        heading?.scrollIntoView?.({ block: 'start' });
        heading?.focus({ preventScroll: true });
      });
      if (narrowViewport) setSidebarCollapsed(true);
      return;
    }
    if (viewDirty && !window.confirm(t('discardUnsavedChanges'))) return;
    setViewDirty(false);
    setViewBusy(false);
    setSettingsSection(nextView === 'settings' ? section : '');
    setActiveView(nextView);
    if (narrowViewport) setSidebarCollapsed(true);
  }, [activeView, narrowViewport, pushToast, t, viewBusy, viewDirty, profilePending, snapshot?.operation]);

  const handleSetupExit = useCallback(() => {
    setViewDirty(false);
    setViewBusy(false);
    setActiveView('dashboard');
    if (narrowViewport) setSidebarCollapsed(true);
  }, [narrowViewport]);

  useEffect(() => {
    if (!scope) return;
    const activation = activationRef.current;
    if (activation.profileId !== scope.profileId) {
      activation.profileId = scope.profileId;
      activation.awaitingProfiles = true;
      setViewDirty(false);
      setViewBusy(false);
      setActiveView((current) => current === 'setup' ? 'dashboard' : current);
    }
    if (!activation.awaitingProfiles || profiles?.activeProfileId !== scope.profileId) return;
    const profile = profiles.profiles.find((item) => item.id === scope.profileId);
    if (!profile) return;
    activation.awaitingProfiles = false;
    // Newness is persisted per profile, never inferred from an absent Cookie.
    // Ordinary navigation and epoch changes must not reopen the temporary route.
    if (profile.onboarding.status === 'new') setActiveView('setup');
  }, [scope?.profileId, profiles]);

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
    if (!drawerOpen) return undefined;
    const sidebar = sidebarRef.current;
    (sidebar?.querySelector('.nav-item[aria-current="page"]') ?? sidebar?.querySelector('.nav-item'))?.focus();
    const handleKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSidebarCollapsed(true);
      } else if (event.key === 'Tab' && sidebar) {
        const buttons = [...sidebar.querySelectorAll('button:not([disabled])')];
        const first = buttons[0];
        const last = buttons.at(-1);
        const outside = !sidebar.contains(document.activeElement);
        if (outside || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('keydown', handleKey);
      if (drawerTriggerRef.current?.isConnected) drawerTriggerRef.current.focus();
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (initialViewRef.current) {
      initialViewRef.current = false;
      return;
    }
    if (mainRef.current) mainRef.current.scrollTop = 0;
    setTopbarCompact(false);
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeView, scope?.profileId]);



  const ActiveComponent = VIEWS[activeView].component;
  const title = t(VIEWS[activeView].key);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">{t('skipToContent')}</a>
      <Sidebar
        activeView={activeView}
        onNavigate={handleNavigate}
        collapsed={sidebarCollapsed}
        navigationRef={sidebarRef}
        modal={drawerOpen}
        onToggle={toggleSidebar}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        locale={locale}
        onToggleLocale={toggleLocale}
        t={t}
        preferencesDisabled={Boolean(snapshot?.storageErrorCode)}
      />
      {narrowViewport && !sidebarCollapsed && (
        <button
          type="button"
          className="sidebar-backdrop"
          tabIndex={-1}
          onClick={() => setSidebarCollapsed(true)}
          aria-label={t('closeSidebar')}
        />
      )}

      <div className="content-shell" inert={drawerOpen}>
        {/* Topbar */}
        <header className={`topbar ${topbarCompact ? 'topbar--compact' : ''}`}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={toggleSidebar}
            style={{ marginRight: '0.75rem' }}
            title={t('toggleSidebar')}
            aria-label={t('toggleSidebar')}
            aria-expanded={!sidebarCollapsed}
            aria-controls="primary-navigation"
          >
            <IconMenu size={18} />
          </button>
          <h1 ref={titleRef} className="topbar-title" tabIndex={-1}>{title}</h1>
          <div className="profile-switcher">
            <label className="sr-only" htmlFor="active-profile">{t('activeProfile')}</label>
            <select id="active-profile" className="form-input" value={scope?.profileId ?? ''} onChange={(event) => { void handleActivateProfile(event.target.value); }} disabled={!scope || !profiles || viewBusy || Boolean(profilePending) || Boolean(snapshot?.operation) || Boolean(snapshot?.storageErrorCode)} aria-busy={Boolean(profilePending)}>
              {!profiles && <option value={scope?.profileId ?? ''}>{t('loadingProfiles')}</option>}
              {profiles?.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <button type="button" className="btn btn-sm" onClick={() => handleNavigate('settings')} disabled={Boolean(profilePending) || Boolean(snapshot?.operation)}>{t('manageProfiles')}</button>
          </div>
        </header>
        <UpdateBanner onReview={() => handleNavigate('settings', 'updates')} />

        {/* Page content */}
        <main id="main-content" ref={mainRef} className="page-content" onScroll={handleContentScroll} tabIndex={-1}>
          {runtimeError && <div role="alert">{formatApiError(runtimeError, t)} <button type="button" className="btn" onClick={retry}>{t('retry')}</button></div>}
          {snapshot?.storageErrorCode && <div className="settings-warning" role="alert">
            <span>{formatApiError({ code: snapshot.storageErrorCode }, t)} {t('settingsLockedHint')}</span>
            <button type="button" className="btn" disabled={retryingStorage} onClick={handleRetryStorage}>{retryingStorage ? t('retrying') : t('retryLoadSettings')}</button>
          </div>}
          {profileError && <div role="alert">{formatApiError(profileError, t)} <button type="button" className="btn" onClick={() => { void reloadProfiles().catch(() => {}); }}>{t('retry')}</button></div>}
          <ActiveComponent key={scope?.profileId ?? 'loading'} onDirtyChange={setViewDirty} onDraftChange={handleDraftChange} onBusyChange={setViewBusy} onNavigate={handleNavigate} onSetupExit={handleSetupExit} initialSection={settingsSection} />
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
            <RuntimeProvider><UpdateProvider><ProfileProvider><AppShell /></ProfileProvider></UpdateProvider></RuntimeProvider>
          </ErrorBoundary>
        </ToastProvider>
      </ThemeProvider>
    </LocaleProvider>
  );
}
