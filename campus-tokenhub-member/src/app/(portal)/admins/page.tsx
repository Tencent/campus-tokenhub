import { redirect } from 'next/navigation';
import { requireCurrentSession } from '@/lib/auth/current';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import { readAdminCandidates } from '@/lib/admin/candidates';
import { readAdminSubs } from '@/lib/admin/roster';
import { AdminList } from '@/components/admin/AdminList';

export const dynamic = 'force-dynamic';

/**
 * 管理员名单维护（成员自购站）。
 *
 * 名单存在共享层 `portal_shared.admins`：与统一采买站同一份数据，任一侧增删对另一侧立即生效。
 * 名单里的人都是全局管理员，能审核成员、进设置、维护名单；也能在同时部署统一采买站时
 * 使用那边的管理入口。
 */
export default async function AdminRosterPage() {
  const session = await requireCurrentSession();

  // 页面挡人，接口自己再判一次
  if (!(await resolvePortalAdmin(session))) redirect('/members');

  const [{ subs, managed, degraded }, candidates] = await Promise.all([
    readAdminSubs(),
    // 候选取不到不影响名单本身的增删，降级成空列表让按钮置灰
    readAdminCandidates({ currentSub: session.sub }).catch(() => []),
  ]);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="text-[13px] leading-[21px] text-ink-500">
          名单存在共享层 portal_shared.admins 表里；名单里的人都是全局管理员，可以审核成员申请、
          维护系统设置，也能维护这份名单。首次登录认领初始化时会自动加入，之后可在这里增删，
          移除后立即失去上述权限。候选项来自已登录过门户的账号与成员申请记录，无需手填身份。
        </p>
      </header>

      <AdminList
        subs={subs}
        currentSub={session.sub}
        managed={managed}
        degraded={degraded}
        candidates={candidates}
      />
    </div>
  );
}
