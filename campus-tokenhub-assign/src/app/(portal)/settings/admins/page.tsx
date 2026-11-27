import { redirect } from 'next/navigation';
import { requireCurrentSession } from '@/lib/auth/current';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import { readAdminCandidates } from '@/lib/admin/candidates';
import { readAdminSubs } from '@/lib/admin/roster';
import { rosterNoticeKind } from '@/lib/admin/roster-notice';
import { RosterEmptyNotice } from '@/components/admin/RosterEmptyNotice';
import { AdminList } from '@/components/admin/AdminList';

export const dynamic = 'force-dynamic';

/**
 * 管理员名单维护（统一采买站）。
 *
 * 名单存在共享层 `portal_shared.admins`：与成员站同一份数据，任一侧增删对另一侧立即生效。
 * 名单里的人都是全局管理员，可使用系统设置、运营活动、网关管理后台与成员审核（如果该站有），
 * 也能维护这份名单。
 */
export default async function AdminRosterPage() {
  const session = await requireCurrentSession();

  // 页面挡人，接口自己再判一次
  if (!(await resolvePortalAdmin(session))) redirect('/overview');

  const [{ subs, managed, degraded }, candidates] = await Promise.all([
    readAdminSubs(),
    // 候选取不到不影响名单本身的增删，降级成空列表让按钮置灰
    readAdminCandidates({ currentSub: session.sub }).catch(() => []),
  ]);
  // 名单为空时首个登录者会被认领为全局管理员：只提示，不改认领逻辑
  const noticeKind = rosterNoticeKind(subs, degraded);

  return (
    <div className="flex flex-col gap-4">
      {noticeKind ? <RosterEmptyNotice kind={noticeKind} /> : null}
      <header>
        <p className="text-[13px] leading-[21px] text-ink-500">
          名单存在共享层 portal_shared.admins 表里；名单里的人都是全局管理员，可以使用系统设置、运营活动、
          网关管理后台，也能维护这份名单。首次登录认领初始化时会自动加入，之后可在这里增删，移除后立即失去上述权限。
          候选项来自已登录过门户的账号，无需手填身份。
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
