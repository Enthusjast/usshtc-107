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

  return (
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label={t('appNavigation')}>
      <button
        type="button"
        className="sidebar-brand"
        aria-expanded={!collapsed}
        aria-label={t('toggleSidebar')}
        aria-controls="primary-navigation"
        onClick={onToggle}
      >
        <span className="sidebar-brand-dot" aria-hidden="true" />
        <span className="sidebar-brand-text">usshtc107</span>
      </button>

      <nav id="primary-navigation" className="sidebar-nav" aria-label={t('primaryNavigation')}>
        {NAV_ITEMS.map(({ id, key, Icon }) => (
          <button
            type="button"
            key={id}
            className={`nav-item ${activeView === id ? 'active' : ''}`}
            aria-current={activeView === id ? 'page' : undefined}
            onClick={() => onNavigate(id)}
            title={t(key)}
          >
            <span className="nav-item-icon" aria-hidden="true"><Icon /></span>
            <span className="nav-item-label">{t(key)}</span>
          </button>
        ))}
      </nav>

      {/* Theme toggle */}
      <button
        type="button"
        className="sidebar-theme-toggle"
        onClick={onToggleTheme}
        title={isDark ? t('switchToLight') : t('switchToDark')}
        aria-label={isDark ? t('switchToLight') : t('switchToDark')}
      >
        <span className="nav-item-icon" aria-hidden="true">
          {isDark ? <IconSun /> : <IconMoon />}
        </span>
        <span className="nav-item-label">{isDark ? t('light') : t('dark')}</span>
      </button>

      {/* Language toggle */}
      <button
        type="button"
        className="sidebar-theme-toggle"
        onClick={onToggleLocale}
        title={locale === 'zh' ? 'Switch to English' : '切换到中文'}
        aria-label={locale === 'zh' ? 'Switch to English' : '切换到中文'}
      >
        <span className="nav-item-icon" aria-hidden="true"><IconGlobe /></span>
        <span className="nav-item-label">{t('language')} · {localeLabel}</span>
      </button>

      <nav className="sidebar-nav-bottom" aria-label={t('secondaryNavigation')}>
        {BOTTOM_ITEMS.map(({ id, key, Icon }) => (
          <button
            type="button"
            key={id}
            className={`nav-item ${activeView === id ? 'active' : ''}`}
            aria-current={activeView === id ? 'page' : undefined}
            onClick={() => onNavigate(id)}
            title={t(key)}
          >
            <span className="nav-item-icon" aria-hidden="true"><Icon /></span>
            <span className="nav-item-label">{t(key)}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
