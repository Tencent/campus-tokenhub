import { getConfig } from '@/lib/config';
import { resolveBranding } from '@/lib/config/branding';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import { requireCurrentSession } from '@/lib/auth/current';
import { isMemberAdmin } from '@/lib/members/access';
import { NavigationProgress } from '@/components/portal/NavigationProgress';
import { Sidebar } from '@/components/portal/Sidebar';
import { TopBar } from '@/components/portal/TopBar';

export const dynamic = 'force-dynamic';

/**
 * 成员站的布局：只有品牌、管理员判定与导航。
 *
 * 与统一采买站（assign）的差异：不再查网关用户状态（没有网关），
 * 也不再算「初始化入口」（成员站没有 /setup）。
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await requireCurrentSession();
  const cfg = getConfig();
  const branding = resolveBranding({ sessionSchoolName: session.school_name, config: cfg });

  const [isAdmin, memberAdmin] = await Promise.all([
    resolvePortalAdmin(session),
    isMemberAdmin(session),
  ]);

  return (
    <div className="min-h-screen bg-cream">
      <NavigationProgress />
      <Sidebar
        isAdmin={isAdmin}
        isMemberAdmin={memberAdmin}
        showSettings={isAdmin}
        schoolName={branding.schoolName}
        logoUrl={branding.logoUrl}
        userName={session.name || session.email || '未命名'}
        userSub={session.email}
      />

      <div className="md:pl-[232px]">
        <TopBar />
        <main className="mx-auto w-full max-w-[1208px] px-6 py-6">{children}</main>
      </div>
    </div>
  );
}
