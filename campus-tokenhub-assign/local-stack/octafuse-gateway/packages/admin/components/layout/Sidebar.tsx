'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 左侧导航：Dashboard、推理与路由、Tools、分析、系统集成、系统（含 Config 与 Logout）；底部外链与版本号。
 */
import Link from '@/ui/link';
import BrandExternalLinks from '@/components/layout/BrandExternalLinks';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { usePathname } from '@/ui/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowLeftStartOnRectangleIcon,
  HomeIcon,
  KeyIcon,
  CpuChipIcon,
  GlobeAltIcon,
  ArrowsRightLeftIcon,
  BeakerIcon,
  PlayCircleIcon,
  DocumentChartBarIcon,
  ClipboardDocumentListIcon,
  ChartBarIcon,
  ServerStackIcon,
  UsersIcon,
  ShieldCheckIcon,
  Cog6ToothIcon,
  PauseCircleIcon,
  WrenchScrewdriverIcon,
  QueueListIcon,
  Squares2X2Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { ADMIN_NAV_GROUPS, type AdminNavNameKey } from '@/lib/admin-nav';
import { matchAdminUiRoute } from '@/lib/admin-ui-route-manifest';
import { adminAppVersion } from '@/lib/app-version';
import { prefetchAdminRoute, type PrefetchTrigger } from '@/ui/prefetch';
import { useAuthSession } from './auth-session';

const NAV_ICONS: Record<AdminNavNameKey, React.ComponentType<{ className?: string }>> = {
  dashboard: HomeIcon,
  providers: GlobeAltIcon,
  models: CpuChipIcon,
  routes: ArrowsRightLeftIcon,
  playground: BeakerIcon,
  simulator: PlayCircleIcon,
  users: UsersIcon,
  apiKeys: KeyIcon,
  requestLogs: DocumentChartBarIcon,
  auditLogs: ClipboardDocumentListIcon,
  toolsConfig: WrenchScrewdriverIcon,
  mcpServers: Squares2X2Icon,
  modelUsage: ChartBarIcon,
  providerUsage: ServerStackIcon,
  userUsage: UsersIcon,
  reliability: ShieldCheckIcon,
  adminApiKeys: KeyIcon,
  config: Cog6ToothIcon,
  maintenance: PauseCircleIcon,
};

export default function Sidebar({
  mobile = false,
  onNavigate,
  prefetchRoute = prefetchAdminRoute,
}: {
  mobile?: boolean;
  onNavigate?: () => void;
  /** 可注入的预取入口；默认为 `ui/prefetch` 的应用级单例。 */
  prefetchRoute?: (routeId: string, trigger: PrefetchTrigger) => void;
}) {
  const t = useTranslations('sidebar');
  const tBrand = useTranslations('brand');
  const tAuth = useTranslations('auth');
  const tCommon = useTranslations('common');
  const pathname = usePathname();
  const { snapshot, logout } = useAuthSession();
  const isLoggingOut = snapshot.pending === 'logout' || snapshot.pending === 'expiry';

  const handleLogout = () => {
    if (snapshot.pending) return;
    void logout();
  };

  return (
    <aside className={mobile ? 'h-full w-full bg-gray-900' : 'hidden h-dvh w-64 shrink-0 bg-gray-900 lg:block'}>
      <div className="flex h-full flex-col">
      {/* Logo / Brand + locale */}
      <div className="flex h-16 shrink-0 items-center justify-between gap-2 bg-gray-950 px-4 leading-tight">
        <Link href="/dashboard" onClick={onNavigate} className="min-w-0 block hover:opacity-90">
          <span className="block truncate text-lg font-bold tracking-tight text-white">{tBrand('wordmark')}</span>
          <span className="block truncate text-[11px] font-medium uppercase tracking-wider text-gray-400">
            {tBrand('sidebarSubtitle')}
          </span>
        </Link>
        {mobile ? (
          <button type="button" onClick={onNavigate} aria-label={tCommon('close')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-gray-300 hover:bg-gray-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500">
            <XMarkIcon className="h-6 w-6" aria-hidden />
          </button>
        ) : <LocaleSwitcher variant="header" />}
      </div>

      {/* Navigation */}
      <nav aria-label={t('navigation')} className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 py-3">
        {ADMIN_NAV_GROUPS.map((group) => (
          <div key={group.groupKey}>
            <h3 className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
              {t(`groups.${group.groupKey}`)}
            </h3>
            <div className="space-y-px">
              {group.items.map((item) => {
                const isActive =
                  pathname === item.href ||
                  (item.href === '/gateway/users' &&
                    (pathname === '/gateway/users' || pathname?.startsWith('/gateway/users/')));
                const Icon = NAV_ICONS[item.nameKey];
                const routeId = matchAdminUiRoute(item.href)?.route.id;
                const intentPrefetch =
                  routeId === undefined
                    ? undefined
                    : () => prefetchRoute(routeId, 'speculative');

                return (
                  <Link
                    key={item.nameKey}
                    href={item.href}
                    onClick={() => {
                      if (routeId !== undefined) prefetchRoute(routeId, 'click');
                      onNavigate?.();
                    }}
                    onMouseEnter={intentPrefetch}
                    onFocus={intentPrefetch}
                    aria-current={isActive ? 'page' : undefined}
                    className={`
                      group flex min-h-11 items-center rounded-md px-3 py-2 text-sm font-medium lg:min-h-0
                      ${isActive
                        ? 'bg-gray-800 text-white'
                        : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                      }
                    `}
                  >
                    <Icon className={`
                      mr-3 h-5 w-5 flex-shrink-0
                      ${isActive ? 'text-white' : 'text-gray-400 group-hover:text-white'}
                    `} />
                    {t(`nav.${item.nameKey}`)}
                  </Link>
                );
              })}
              {group.groupKey === 'system' && (
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={isLoggingOut}
                  className="group flex w-full items-center rounded-md px-3 py-2 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ArrowLeftStartOnRectangleIcon className="mr-3 h-5 w-5 flex-shrink-0 text-gray-400 group-hover:text-white" />
                  {isLoggingOut ? tAuth('loggingOut') : tAuth('logout')}
                </button>
              )}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer: links + version */}
      <div className="shrink-0 space-y-3 border-t border-gray-800 p-4">
        <BrandExternalLinks variant="sidebar" />
        <p className="text-center text-xs text-gray-500">{t('version', { version: adminAppVersion })}</p>
      </div>
      </div>
    </aside>
  );
}
