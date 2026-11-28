import { getConfig } from '@/lib/config';
import { resolveBranding } from '@/lib/config/branding';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import { requireCurrentSession } from '@/lib/auth/current';
import { canAccessSetup } from '@/lib/onboarding/access';
import { getUser } from '@/lib/gateway/users';
import { NavigationProgress } from '@/components/portal/NavigationProgress';
import { Sidebar } from '@/components/portal/Sidebar';
import { TopBar } from '@/components/portal/TopBar';
import { VisitTracker } from '@/components/portal/VisitTracker';
import { isActivityEnabled } from '@/lib/activity/enabled';
import { appPath } from '@/lib/paths';

export const dynamic = 'force-dynamic';

/**
 * 顶栏的账户状态徽标需要网关用户状态。
 * 读不到（未开户 / 网关不可达）时返回 null，徽标不渲染，页面本身不受影响。
 */
async function loadAccountStatus(userId: string | null): Promise<string | null> {
  if (!userId) return null;
  try {
    const user = await getUser(userId);
    return user.status ?? null;
  } catch {
    return null;
  }
}

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireCurrentSession();
  const cfg = getConfig();
  const branding = resolveBranding({ sessionSchoolName: session.school_name, config: cfg });
  // 本地引导账号或数据库管理员名单命中（按 external_user_id 判定，不依赖邮箱）
  const isAdmin = await resolvePortalAdmin(session);

  // 初始化入口常驻给管理员：完成后点进去看到的是完成状态
  const [showSetup, accountStatus, activityEnabled] = await Promise.all([
    canAccessSetup(session),
    loadAccountStatus(session.octafuse_user_id ?? null),
    // 设置页「登录数据统计」开关，缺省关闭；关闭时连 VisitTracker 都不挂
    isActivityEnabled(),
  ]);

  // 共享页面（如 /members/admins）的模式由链接上的 `?mode=` 决定，见 Sidebar / TopBar
  return (
    <div className="min-h-screen bg-cream">
      <NavigationProgress />
      {/* 页面访问上报：只在 pathname 变化时触发，不阻塞渲染 */}
      {activityEnabled ? (
        <VisitTracker endpoint={appPath('/api/portal/activity/visit')} />
      ) : null}
      <Sidebar
        // 侧边栏入口只关心「管理台是否配了公网地址」：没配就不显示。
        // 不能用容器内网地址（gateway-admin:8789）兜底——它是 truthy，会让入口显示出来，
        // 点进去却因为 admin-entry 拿不到公网基址而只得到一页 500 说明。
        adminBase={cfg.portal.adminPublicBaseUrl || null}
        // 只有双站部署才配；空值时侧边栏不显示成员账号入口
        memberBase={cfg.portal.memberPublicBaseUrl}
        isAdmin={isAdmin}
        showSetup={showSetup}
        showSettings={isAdmin}
        // 优先用登录时认证方返回的真实校名；mock / OIDC 没有时回退到配置的校名
        schoolName={branding.schoolName}
        logoUrl={branding.logoUrl}
        userName={session.name || session.email || '未命名'}
        userSub={session.email}
      />

      <div className="md:pl-[232px]">
        <TopBar accountStatus={accountStatus} />
        <main className="mx-auto w-full max-w-[1208px] px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
