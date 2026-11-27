import { redirect } from 'next/navigation';
import { requireCurrentSession } from '@/lib/auth/current';
import { canManageActivities } from '@/lib/activities/access';
import { readActivityConfig } from '@/lib/activities/store';
import { ActivityConfigEditor } from '@/components/activities/ActivityConfigEditor';

export const dynamic = 'force-dynamic';

export default async function ActivitiesPage() {
  const session = await requireCurrentSession();

  // 页面与接口各自判定：接口侧再按同一口径（门户管理员）拦一次
  if (!(await canManageActivities(session))) redirect('/overview');

  const { activities, managed, degraded } = await readActivityConfig();

  return (
    <div className="flex flex-col gap-4">
      <header>
        <p className="text-[13px] leading-[21px] text-ink-500">
          配置统一采买模式下「领取算力」的活动卡：名称、面额、领取频次与时间窗。保存后写入门户数据库，学生刷新页面即按新配置展示；
          活动 ID 会进加额幂等键，上线后不要修改。
        </p>
      </header>

      <ActivityConfigEditor initial={activities} managed={managed} degraded={degraded} />
    </div>
  );
}
