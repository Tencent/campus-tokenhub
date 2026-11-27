'use client';

import { usePathname } from 'next/navigation';

/** 路由 → 顶栏标题。子路由（如 /models/xxx）回退到首个匹配的段。 */
const TITLES: { match: string; title: string }[] = [
  { match: '/overview', title: '我的算力' },
  { match: '/models/', title: '模型详情' },
  { match: '/models', title: '模型集市' },
  { match: '/dashboard', title: '数据看板' },
  { match: '/guide', title: '接入指南' },
  { match: '/playground', title: '在线调试台' },
  { match: '/members/review', title: '成员审核' },
  { match: '/members/admins', title: '管理员' },
  { match: '/members', title: '成员账号' },
  { match: '/setup', title: '初始化' },
];

function resolveTitle(pathname: string): string {
  const hit = TITLES.find((item) => pathname === item.match || pathname.startsWith(item.match));
  return hit?.title ?? '门户';
}

/** 账户状态：网关 status 为 active 才算正常，其余一律按异常提示。 */
function AccountBadge({ status }: { status: string | null }) {
  if (!status) return null;
  const ok = status === 'active';
  return (
    <span
      className={`flex h-6 items-center gap-1.5 rounded-[4px] px-2 text-xs font-medium ${
        ok ? 'bg-[#E8F5EE] text-[#17914F]' : 'bg-[#FDECEA] text-[#D93B2B]'
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-[3px] ${ok ? 'bg-[#17914F]' : 'bg-[#D93B2B]'}`} />
      {ok ? '已开通' : '已停用'}
    </span>
  );
}

export function TopBar({
  accountStatus,
}: {
  accountStatus?: string | null;
}) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-line bg-white px-6">
      <h1 className="ml-12 truncate text-[15px] font-semibold leading-6 text-ink-900 md:ml-0">{resolveTitle(pathname)}</h1>

      <div className="flex shrink-0 items-center gap-3">

      </div>
    </header>
  );
}
