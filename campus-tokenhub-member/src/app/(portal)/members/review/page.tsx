import { redirect } from 'next/navigation';
import { requireCurrentSession } from '@/lib/auth/current';
import { isMemberAdmin } from '@/lib/members/access';
import { readStore, sortForReview } from '@/lib/members/store';
import type { MemberApplication } from '@/lib/members/types';
import { ReviewList } from '@/components/members/ReviewList';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  const session = await requireCurrentSession();

  // 页面与接口各自判定：接口按管理员名单（portal_shared.admins）再判一次，页面负责把非管理员挡在门外
  if (!(await isMemberAdmin(session))) redirect('/members');

  let applications: MemberApplication[] = [];
  let loadFailed = false;
  try {
    applications = sortForReview(await readStore());
  } catch {
    loadFailed = true;
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="text-[13px] leading-[21px] text-ink-500">
          通过即调用腾讯云接口建号并绑定邮箱手机；驳回必须填写理由，老师会看到。
        </p>
      </header>

      {loadFailed ? (
        <p role="alert" className="rounded-card border border-[#F5C2BE] bg-[#FDECEA] px-4 py-3 text-sm text-danger">
          申请数据读取失败，请检查数据目录权限或联系运维。
        </p>
      ) : (
        <ReviewList applications={applications} />
      )}
    </div>
  );
}
