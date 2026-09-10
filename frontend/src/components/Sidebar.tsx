import { Layout, Tooltip } from '../antdImports';
import {
  BarChartOutlined,
  HistoryOutlined,
  TrophyOutlined,
  LogoutOutlined,
  AppstoreOutlined,
  DatabaseOutlined,
  SafetyCertificateOutlined,
  ExperimentOutlined,
} from '@ant-design/icons';
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { LanguageSwitcher } from './LanguageSwitcher';
import { LogoLockup } from './Logo';

const { Sider } = Layout;

export type PageType =
  | 'workflow'
  | 'history'
  | 'history-detail'
  | 'playground'
  | 'modules'
  | 'modelLibrary'
  | 'identity'
  | 'quality';

export const SIDEBAR_WIDTH = 248;

interface NavListProps {
  activePage: PageType;
  onNavigate: (page: PageType) => void;
  runningLabel?: string;
}

interface NavEntry {
  key: PageType;
  icon: ReactNode;
  label: string;
}

/**
 * Navigation list shared by the desktop sidebar and the mobile drawer.
 * Items are grouped so the purpose of each section is obvious at a glance.
 */
export function NavList({ activePage, onNavigate, runningLabel }: NavListProps) {
  const { t } = useTranslation();

  const groups: { label: string; items: NavEntry[] }[] = [
    {
      label: t('nav.group.test'),
      items: [
        { key: 'workflow', icon: <BarChartOutlined />, label: t('nav.workflow') },
        { key: 'history', icon: <HistoryOutlined />, label: t('nav.history') },
        { key: 'modules', icon: <AppstoreOutlined />, label: t('nav.modules') },
        { key: 'modelLibrary', icon: <DatabaseOutlined />, label: t('nav.modelLibrary') },
        { key: 'identity', icon: <SafetyCertificateOutlined />, label: t('nav.identity') },
        { key: 'quality', icon: <ExperimentOutlined />, label: t('nav.quality') },
      ],
    },
    {
      label: t('nav.group.tools'),
      items: [{ key: 'playground', icon: <TrophyOutlined />, label: t('nav.playground') }],
    },
  ];

  const current = activePage === 'history-detail' ? 'history' : activePage;

  return (
    <nav className="px-3 pb-2" aria-label={t('nav.ariaLabel')}>
      {groups.map((group) => (
        <div key={group.label}>
          <div className="nav-group-label">{group.label}</div>
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const active = current === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onNavigate(item.key)}
                  className={`nav-item${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <span className="truncate">{item.label}</span>
                  {item.key === 'workflow' && runningLabel && <span className="nav-badge">{runningLabel}</span>}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

interface SidebarProps {
  activePage: PageType;
  onNavigate: (page: PageType) => void;
  isRunning?: boolean;
  runningLabel?: string;
  onLogout?: () => void;
}

export function Sidebar({ activePage, onNavigate, isRunning, runningLabel, onLogout }: SidebarProps) {
  const { t } = useTranslation();

  return (
    <Sider
      width={SIDEBAR_WIDTH}
      theme="light"
      data-tour="nav"
      style={{
        position: 'fixed',
        height: '100vh',
        left: 0,
        top: 0,
        bottom: 0,
        overflow: 'hidden auto',
        zIndex: 100,
        background: '#ffffff',
        borderRight: '1px solid var(--color-border)',
      }}
    >
      {/* Brand */}
      <div className="px-4 pt-5 pb-4">
        <LogoLockup />
      </div>

      <div className="mx-4 h-px" style={{ background: 'var(--color-border)' }} />

      <NavList activePage={activePage} onNavigate={onNavigate} runningLabel={isRunning ? runningLabel : undefined} />

      {/* Status footer */}
      <div
        className="absolute bottom-0 left-0 right-0 px-4 py-3 bg-white"
        style={{ borderTop: '1px solid var(--color-border)' }}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className="relative flex h-[7px] w-[7px] flex-shrink-0">
              {isRunning && (
                <span className="absolute inline-flex h-full w-full rounded-full bg-accent-amber opacity-60 animate-ping" />
              )}
              <span
                className={`relative inline-flex h-[7px] w-[7px] rounded-full ${
                  isRunning ? 'bg-accent-amber' : 'bg-accent-teal'
                }`}
              />
            </span>
            <span
              className={`text-[11px] font-medium font-mono truncate ${
                isRunning ? 'text-accent-amber' : 'text-text-tertiary'
              }`}
            >
              {isRunning ? runningLabel || t('common.status.running') : t('common.status.ready')}
            </span>
          </div>
          <div className="flex items-center gap-2.5 flex-shrink-0">
            <LanguageSwitcher />
            {onLogout && (
              <Tooltip title={t('nav.signOut')}>
                <button
                  onClick={onLogout}
                  className="text-text-tertiary hover:text-accent-rose transition-colors p-1"
                  aria-label={t('nav.signOut')}
                >
                  <LogoutOutlined style={{ fontSize: 13 }} />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </Sider>
  );
}
