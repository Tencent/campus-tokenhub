/**
 * 侧边栏的两组入口：用户入口与管理入口（成员自购站，单模式）。
 *
 * 这里只产出**纯数据**（图标用 key 引用），渲染留在 `Sidebar.tsx`：
 * 数据层可以在 node 环境单测，不需要引入 DOM 测试依赖。
 *
 * 与统一采买站（assign）的差异：没有算力、模型集市、看板、接入指南这些网关侧入口，
 * 也没有模式概念；管理员名单入口在 `/admins`（平级，不在设置页下）。
 */

export type NavIconKey = 'members' | 'review' | 'admins' | 'setup';

export type NavItem = {
  href: string;
  label: string;
  icon: NavIconKey;
  /** 站外链接：新标签页打开，不参与 active 判定 */
  external?: boolean;
};

export type NavGroups = {
  user: NavItem[];
  admin: NavItem[];
};

const MEMBERS: NavItem = { href: '/members', label: '成员账号', icon: 'members' };
const REVIEW: NavItem = { href: '/members/review', label: '成员审核', icon: 'review' };
const ADMINS: NavItem = { href: '/admins', label: '管理员', icon: 'admins' };
const SETTINGS: NavItem = { href: '/settings', label: '系统设置', icon: 'setup' };

const USER_NAV: readonly NavItem[] = [MEMBERS];

export type BuildNavInput = {
  /** 是否全局管理员（能进设置与管理员名单） */
  isAdmin: boolean;
  /** 是否能审核成员（名单接管后与 isAdmin 同口径） */
  isMemberAdmin: boolean;
  /** 运行期配置页入口：仅全局管理员可见；缺省不展示 */
  showSettings?: boolean;
};

export function buildNav(input: BuildNavInput): NavGroups {
  const user = [...USER_NAV];
  const admin: NavItem[] = [];

  if (input.isMemberAdmin) admin.push(REVIEW);
  if (input.isAdmin) admin.push(ADMINS);
  if (input.isAdmin && input.showSettings) admin.push(SETTINGS);

  return { user, admin };
}

/**
 * 单个导航项是否命中当前路径。
 *
 * 按路径段前缀匹配（`/members/review` 命中 `/members`）；站外链接不参与判定。
 *
 * 注意：这是**单项**判定，父子入口会同时命中（`/members/review` 同时命中
 * `/members` 与 `/members/review`）。要决定「渲染时该高亮哪一项」请用
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
 * 解决父子入口同时命中导致的两处高亮：在 `/members/review` 下，
 * `/members/review`（更长）胜出，「成员账号」不再高亮；而在 `/members`
 * 自身或其他 `/members/xxx` 子页时，仍由「成员账号」兜底高亮。
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
