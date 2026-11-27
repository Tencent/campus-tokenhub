'use client';

import Link, { useLinkStatus } from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { appPath } from '@/lib/paths';
import { buildNav, resolveActiveHref, type NavIconKey, type NavItem } from '@/lib/portal/nav';

/** 导航图标统一 16px、1.8 描边（设计稿：线性图标 16 / 20px） */
function IconAccount() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="1.9" y="3.4" width="12.2" height="9" rx="1.8" stroke="currentColor" strokeWidth="1.8" />
      <path d="M1.9 6.6h12.2" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="11.3" cy="9.8" r="0.95" fill="currentColor" />
    </svg>
  );
}

function IconModels() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2" width="4.7" height="4.7" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
      <rect x="9.3" y="2" width="4.7" height="4.7" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
      <rect x="2" y="9.3" width="4.7" height="4.7" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
      <rect x="9.3" y="9.3" width="4.7" height="4.7" rx="1.2" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.3 2.3v11.4h11.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M5.4 10.6V7.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M8.6 10.6V4.9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M11.8 10.6V6.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function IconGuide() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.6 3.4c0-.6.5-1.1 1.1-1.1h3.1c.4 0 .8.2 1.1.5l.5.5v10.3l-.6-.5a1.6 1.6 0 00-1-.4H3.7c-.6 0-1.1-.5-1.1-1.1V3.4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M13.4 3.4c0-.6-.5-1.1-1.1-1.1H9.2c-.4 0-.8.2-1.1.5L7.6 3v10.3l.6-.5c.3-.3.6-.4 1-.4h3.1c.6 0 1.1-.5 1.1-1.1V3.4z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconMembers() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="6" cy="5.4" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M2.2 13c0-2.1 1.7-3.4 3.8-3.4S9.8 10.9 9.8 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11 3.6a2 2 0 010 3.9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.4 13c0-1.4-.5-2.4-1.4-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconExit() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M9.8 3.6V2.9a.9.9 0 00-.9-.9H3.5a.9.9 0 00-.9.9v10.2a.9.9 0 00.9.9h5.4a.9.9 0 00.9-.9v-.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path d="M6.9 8h6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M11.2 5.9L13.4 8l-2.2 2.1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconActivities() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3.2 6.1h1.9l6-2.9v9.6l-6-2.9H3.2A1.2 1.2 0 012 8.7V7.3a1.2 1.2 0 011.2-1.2z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M5.4 9.9v2.4c0 .6.5 1.1 1.1 1.1h.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.9 5.9a3.2 3.2 0 010 4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function IconSetup() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.4 5.2h11.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M2.4 10.8h11.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="6.2" cy="5.2" r="1.8" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="10" cy="10.8" r="1.8" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function IconExternal() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M9.4 2.6h4v4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.2 2.8L7.6 8.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12.2 9.6v3a.9.9 0 01-.9.9H3.5a.9.9 0 01-.9-.9V4.7a.9.9 0 01.9-.9h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

const ICONS: Record<NavIconKey, React.ReactNode> = {
  account: <IconAccount />,
  models: <IconModels />,
  chart: <IconChart />,
  guide: <IconGuide />,
  members: <IconMembers />,
  admins: <IconMembers />,
  activities: <IconActivities />,
  setup: <IconSetup />,
  external: <IconExternal />,
};

/**
 * 点击后的跳转中态上报通道。
 *
 * 高亮是「全局至多一项」，所以 pending 不能各自为政：某个入口正在跳转时，
 * 由它把 href 上报到 Sidebar，Sidebar 用它压制当前 active 项的高亮，
 * 否则点「系统设置」的几百毫秒里会看到旧项与目标项同时亮。
 */
const ReportPendingContext = createContext<React.Dispatch<React.SetStateAction<string | null>> | null>(
  null,
);

/**
 * 导航项内容必须在 `<Link>` 内部才能用 useLinkStatus：
 * 点击后 pending 立即为 true，先把高亮切到目标项，避免等路由提交的几百毫秒里菜单毫无反馈。
 */
function NavItemBody({ href, label, active, icon }: { href: string; label: string; active: boolean; icon: React.ReactNode }) {
  const { pending } = useLinkStatus();
  const reportPending = useContext(ReportPendingContext);

  // 只有跳转中才占用高亮位；pending 结束或卸载时把位置让回 active
  useEffect(() => {
    if (!reportPending || !pending) return;
    reportPending(href);
    return () => reportPending((current) => (current === href ? null : current));
  }, [pending, href, reportPending]);

  return (
    <span
      className={`relative flex h-10 items-center gap-2.5 rounded-control px-2.5 transition ${
        active ? 'bg-brand-orange-soft text-[#2657D6]' : 'text-ink-700 hover:bg-cream-100'
      }`}
    >
      {active && (
        <span aria-hidden className="absolute left-0 top-3 h-4 w-[3px] rounded-[2px] bg-[#2657D6]" />
      )}
      <span className={`shrink-0 ${active ? 'text-[#2657D6]' : 'text-ink-500'}`}>{icon}</span>
      <span className="truncate text-sm leading-5">{label}</span>
    </span>
  );
}

/** 站外链接（网关管理后台）没有 pending 语义，也不参与高亮，单独一份静态外壳。 */
function ExternalItemBody({ label, icon }: { label: string; icon: React.ReactNode }) {
  return (
    <span className="flex h-10 items-center gap-2.5 rounded-control px-2.5 text-ink-700 transition hover:bg-cream-100">
      <span className="shrink-0 text-ink-500">{icon}</span>
      <span className="truncate text-sm leading-5">{label}</span>
      <span className="sr-only">（在新标签页打开）</span>
    </span>
  );
}

function NavEntry({ item, activeHref, onNavigate }: { item: NavItem; activeHref: string | null; onNavigate: () => void }) {
  const icon = ICONS[item.icon];

  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer" className="block" onClick={onNavigate}>
        <ExternalItemBody label={item.label} icon={icon} />
      </a>
    );
  }

  const active = item.href === activeHref;
  return (
    <Link
      href={item.href}
      prefetch={true}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className="block"
    >
      <NavItemBody href={item.href} label={item.label} icon={icon} active={active} />
    </Link>
  );
}

/** 一个入口分组：标题 + 若干入口；组内为空时整组（含标题）不渲染。 */
function NavGroup({
  id,
  title,
  items,
  activeHref,
  onNavigate,
}: {
  id: string;
  title: string;
  items: NavItem[];
  activeHref: string | null;
  onNavigate: () => void;
}) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="px-2.5 pb-1 pt-1 text-[11px] font-medium leading-4 text-ink-500">
        {title}
      </h2>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <NavEntry key={item.href} item={item} activeHref={activeHref} onNavigate={onNavigate} />
        ))}
      </div>
    </section>
  );
}

export function Sidebar({
  adminBase,
  memberBase = '',
  isAdmin,
  showSetup = false,
  showSettings = false,
  schoolName,
  logoUrl = '',
  userName,
  userSub,
}: {
  adminBase: string | null;
  /** 成员自购站公网基址；仅双站部署时由服务端传入 */
  memberBase?: string;
  isAdmin: boolean;
  /** 是否展示初始化入口：服务端判定为管理员（或首次部署待认领）时为 true */
  showSetup?: boolean;
  /** 是否展示「设置」入口：服务端判定为全局管理员时为 true */
  showSettings?: boolean;
  /** 顶部署名：登录返回的校名，或配置里的校名 */
  schoolName: string;
  /** 配置的 Logo 读取地址；为空时用内置图标 */
  logoUrl?: string;
  userName: string;
  /** 姓名下的副标题：门户拿不到学院信息，退化为邮箱 */
  userSub: string;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);

  const nav = buildNav({ isAdmin, showSetup, showSettings, adminBase, memberBase });

  // 高亮只有一个真相：跳转中的目标项优先，否则取路径命中的最深入口。
  // 站外链接（/api/auth/admin-entry）不参与命中，排除后再算。
  const linkHrefs = [...nav.user, ...nav.admin].filter((item) => !item.external).map((item) => item.href);
  const highlightedHref = pendingHref ?? resolveActiveHref(pathname, linkHrefs);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      toggleRef.current?.focus();
    };

    document.addEventListener('keydown', onKeyDown);
    // 打开抽屉后把焦点送进导航，键盘用户不用再 Tab 一整圈
    navRef.current?.querySelector<HTMLAnchorElement>('a[href]')?.focus();

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <button
        ref={toggleRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="fixed left-4 top-3 z-40 rounded-control border border-line bg-white px-3 py-1.5 text-sm text-ink-700 md:hidden"
        aria-expanded={open}
        aria-controls="portal-nav"
        aria-label="切换导航"
      >
        {open ? '收起' : '菜单'}
      </button>

      {open && (
        <div
          aria-hidden
          onClick={() => {
            setOpen(false);
            toggleRef.current?.focus();
          }}
          className="fixed inset-0 z-[25] bg-ink-900/20 md:hidden"
        />
      )}

      <aside
        id="portal-nav"
        aria-label="主导航"
        className={`${
          open ? 'flex' : 'hidden'
        } fixed inset-y-0 left-0 z-30 w-[232px] flex-col gap-[18px] border-r border-line bg-white px-3 pb-3.5 pt-[18px] md:flex`}
      >
        <div className="flex h-10 items-center gap-2.5 pl-1.5">
          {logoUrl ? (
            // 学校自己的 Logo：固定 32×32，避免不同尺寸把侧边栏撑变形
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="" className="h-8 w-8 shrink-0 rounded-lg object-contain" />
          ) : (
          <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-orange-soft">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M9 2.4l6.2 3.4v6.4L9 15.6 2.8 12.2V5.8L9 2.4z" stroke="#2557D6" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M6.6 7.4v3.4c0 .6.5 1 1 1h2.8" stroke="#2557D6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          )}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold leading-tight text-ink-900">{schoolName}</div>
            <div className="mt-0.5 truncate text-[11px] leading-4 text-ink-500">
              MaaS工作台 · 统一采买
            </div>
          </div>
        </div>

        <nav ref={navRef} aria-label="主导航" className="flex flex-col gap-3">
          <ReportPendingContext.Provider value={setPendingHref}>
            <NavGroup
              id="portal-user-nav-title"
              title="用户入口"
              items={nav.user}
              activeHref={highlightedHref}
              onNavigate={() => setOpen(false)}
            />

            {nav.admin.length > 0 && (
              <>
                <span aria-hidden className="h-px w-full bg-cream-200" />
                <NavGroup
                  id="portal-admin-nav-title"
                  title="管理入口"
                  items={nav.admin}
                  activeHref={highlightedHref}
                  onNavigate={() => setOpen(false)}
                />
              </>
            )}
          </ReportPendingContext.Provider>
        </nav>

        <span aria-hidden className="h-px w-full bg-cream-200" />

        <div className="mt-auto flex flex-col gap-3">
          <div className="flex items-center gap-2.5 border-t border-cream-200 pt-3">
            <span
              aria-hidden
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-orange-soft text-[13px] font-semibold text-[#2557D6]"
            >
              {userName.trim().charAt(0).toUpperCase() || '?'}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium leading-tight text-ink-900">{userName}</div>
              <div className="mt-0.5 truncate text-[11px] leading-4 text-ink-500">{userSub}</div>
            </div>
            <form action={appPath('/api/auth/logout')} method="post">
              <button
                type="submit"
                aria-label="退出登录"
                title="退出登录"
                className="flex h-7 w-7 items-center justify-center rounded-control text-ink-500 transition hover:bg-cream-100 hover:text-ink-900"
              >
                <IconExit />
              </button>
            </form>
          </div>
        </div>
      </aside>
    </>
  );
}
