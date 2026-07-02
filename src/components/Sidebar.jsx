import { useCallback } from 'react';
import {
  IconDashboard, IconTerminal, IconScrollText, IconSettings,
  IconSun, IconMoon, IconGlobe,
} from './Icons';

const NAV_ITEMS = [
  { id: 'dashboard', key: 'dashboard', Icon: IconDashboard },
  { id: 'sessions',  key: 'sessions',  Icon: IconTerminal },
  { id: 'logs',      key: 'logs',      Icon: IconScrollText },
];

const BOTTOM_ITEMS = [
  { id: 'settings', key: 'settings', Icon: IconSettings },
];

export default function Sidebar({
  activeView, onNavigate, collapsed, onToggle,
  theme, onToggleTheme, locale, onToggleLocale, t,
}) {
  const isDark = theme === 'dark';
  const localeLabel = locale === 'zh' ? 'EN' : '中';

  const handleKeyNav = useCallback((id, e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onNavigate(id);
    }
  }, [onNavigate]);

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
      <div
        className="sidebar-brand"
        role="button"
        tabIndex={0}
        aria-expanded={!collapsed}
        aria-label={t('toggleSidebar')}
        onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      >
        <div className="sidebar-brand-dot" />
        <span className="sidebar-brand-text">usshtc107</span>
      </div>

      <nav className="sidebar-nav" role="navigation" aria-label={t('dashboard')}>
        {NAV_ITEMS.map(({ id, key, Icon }) => (
          <div
            key={id}
            className={`nav-item ${activeView === id ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            aria-current={activeView === id ? 'page' : undefined}
            onClick={() => onNavigate(id)}
            onKeyDown={(e) => handleKeyNav(id, e)}
            title={t(key)}
          >
            <span className="nav-item-icon"><Icon /></span>
            <span className="nav-item-label">{t(key)}</span>
          </div>
        ))}
      </nav>

      {/* Theme toggle */}
      <button
        className="sidebar-theme-toggle"
        onClick={onToggleTheme}
        title={isDark ? t('switchToLight') : t('switchToDark')}
        aria-label={isDark ? t('switchToLight') : t('switchToDark')}
      >
        <span className="nav-item-icon">
          {isDark ? <IconSun /> : <IconMoon />}
        </span>
        <span className="nav-item-label">{isDark ? t('light') : t('dark')}</span>
      </button>

      {/* Language toggle */}
      <button
        className="sidebar-theme-toggle"
        onClick={onToggleLocale}
        title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
        aria-label={locale === 'zh' ? 'Switch to English' : '切换到中文'}
      >
        <span className="nav-item-icon"><IconGlobe /></span>
        <span className="nav-item-label">{t('language')} · {localeLabel}</span>
      </button>

      <nav className="sidebar-nav-bottom" role="navigation" aria-label={t('settings')}>
        {BOTTOM_ITEMS.map(({ id, key, Icon }) => (
          <div
            key={id}
            className={`nav-item ${activeView === id ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            aria-current={activeView === id ? 'page' : undefined}
            onClick={() => onNavigate(id)}
            onKeyDown={(e) => handleKeyNav(id, e)}
            title={t(key)}
          >
            <span className="nav-item-icon"><Icon /></span>
            <span className="nav-item-label">{t(key)}</span>
          </div>
        ))}
      </nav>
    </aside>
  );
}
