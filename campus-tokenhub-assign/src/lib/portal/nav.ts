/**
 * 侧边栏的两组入口：用户入口与管理入口（统一采买站，单模式）。
 *
 * 这里只产出**纯数据**（图标用 key 引用），渲染留在 `Sidebar.tsx`：
 * 数据层可以在 node 环境单测，不需要引入 DOM 测试依赖。
 *
 * 与成员站（member）的差异：没有模式概念，入口固定；管理员名单入口在 `/settings/admins`。
 */

import { appPath } from '../paths';

export type NavIconKey =
  | 'account'
  | 'models'
  | 'chart'
  | 'guide'
  | 'members'
  | 'activities'
  | 'setup'
  | 'admins'
  | 'external';

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconKey;
  /** 站外链接（网关管理后台）：新标签页打开，不参与 active 判定 */
  external?: boolean;
};

export type NavGroups = {
  user: NavItem[];
  admin: NavItem[];
};

const OVERVIEW: NavItem = { href: '/overview', label: '我的算力', icon: 'account' };
const MODELS: NavItem = { href: '/models', label: '模型集市', icon: 'models' };
const DASHBOARD: NavItem = { href: '/dashboard', label: '数据看板', icon: 'chart' };
const GUIDE: NavItem = { href: '/guide', label: '接入指南', icon: 'guide' };
const ACTIVITIES: NavItem = { href: '/activities', label: '运营活动', icon: 'activities' };
const SETUP: NavItem = { href: '/setup', label: '初始化', icon: 'setup' };
const ADMINS: NavItem = { href: '/settings/admins', label: '管理员', icon: 'admins' };
const SETTINGS: NavItem = { href: '/settings', label: '系统设置', icon: 'setup' };

const USER_NAV: readonly NavItem[] = [OVERVIEW, MODELS, DASHBOARD, GUIDE];

export type BuildNavInput = {
  isAdmin: boolean;
  showSetup: boolean;
  /** 运行期配置页入口：仅门户管理员可见；缺省不展示（兼容既有调用） */
  showSettings?: boolean;
  /** 网关管理后台的公网地址；为空时不渲染该外链 */
  adminBase: string | null;
  /** 成员自购站的公网基址；仅双站部署时传入，传入后用户入口追加「成员账号」 */
  memberBase?: string;
};

export function buildNav(input: BuildNavInput): NavGroups {
  const user = [...USER_NAV];
  const admin: NavItem[] = [];

  // 只部署统一采买站时不显示；双站同域部署时给普通用户一个直达成员站的入口。
  // 沿用 external 语义：新标签页打开，且当前页不高亮它。
  if (input.memberBase) {
    user.push({
      href: `${input.memberBase.replace(/\/+$/, '')}/members`,
      label: '成员账号',
      icon: 'members',
      external: true,
    });
  }

  // 初始化入口常驻给管理员：完成后点进去看到的是完成状态
  if (input.showSetup) admin.push(SETUP);
  // 运营活动配置由学校管理员自己维护
  if (input.isAdmin) admin.push(ACTIVITIES);
  // 管理员名单属于门户内页面，排在站外的网关管理后台之前
  if (input.isAdmin) admin.push(ADMINS);
  // 运行期配置页：学校自己改品牌、额度、登录方式
  if (input.isAdmin && input.showSettings) admin.push(SETTINGS);
  // 站外入口固定放管理入口最后一项
  if (input.isAdmin && input.adminBase) {
    admin.push({
      // 先经门户重签会话补 admin claim：直接跳管理台时，老会话（管理员授权前签发的）
      // 会被判成未登录并踢回登录页。admin-entry 会带着公网基址再跳过去。
      href: appPath('/api/auth/admin-entry'),
      label: '网关管理后台',
      icon: 'external',
      external: true,
    });
  }

  return { user, admin };
}

/**
 * 单个导航项是否命中当前路径。
 *
 * 按路径段前缀匹配（`/models/xxx` 命中 `/models`）；站外链接不参与判定。
 *
 * 注意：这是**单项**判定，父子入口会同时命中（`/settings/admins` 同时命中
 * `/settings` 与 `/settings/admins`）。要决定「渲染时该高亮哪一项」请用
 * `resolveActiveHref`，它保证任一时刻最多一项选中。
 */
export function isNavItemActive(pathname: string, href: string): boolean {
  if (!href.startsWith('/')) return false;
  const target = href.split('?')[0];
  const path = pathname.split('?')[0];
  return path === target || path.startsWith(`${target}/`);
}

/**
 * 在一组入口里挑出当前唯一应高亮的那一项：命中项中 href 最长者优先。
 *
 * 解决父子入口同时命中导致的两处高亮：在 `/settings/admins` 下，
 * `/settings/admins`（更长）胜出，`/settings` 不再高亮；而在 `/settings`
 * 自身或其他 `/settings/xxx` 子页时，仍由 `/settings` 兜底高亮。
 *
 * 站外链接（`external`）与不命中的入口都不参与，全部不命中时返回 null。
 */
export function resolveActiveHref(pathname: string, hrefs: readonly string[]): string | null {
  let best: string | null = null;

  for (const href of hrefs) {
    if (!isNavItemActive(pathname, href)) continue;
    // 比深度不比原始字符串：带 query 的 href 不应因参数更长而胜出
    if (best === null || href.split('?')[0].length > best.split('?')[0].length) best = href;
  }

  return best;
}
