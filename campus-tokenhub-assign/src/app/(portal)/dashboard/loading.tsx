import { SkeletonBlock, SkeletonCard, SkeletonRegion } from '@/components/portal/Skeleton';

/** 看板骨架：4 个 KPI + 两个 tab + 趋势图，避免切页时高度跳动 */
export default function Loading() {
  return (
    <SkeletonRegion className="space-y-5">
      <div>
        <SkeletonBlock className="h-3 w-16" />
        <SkeletonBlock className="mt-2 h-8 w-40" />
        <SkeletonBlock className="mt-2 h-4 w-64" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((index) => (
          <SkeletonBlock key={index} className="h-[118px] rounded-card" />
        ))}
      </div>
      <SkeletonBlock className="h-9 w-56 rounded-full" />
      <SkeletonBlock className="h-[300px] rounded-card" />
      <div className="grid gap-5 xl:grid-cols-3">
        <SkeletonCard className="xl:col-span-2" rows={5} />
        <SkeletonCard rows={3} />
      </div>
    </SkeletonRegion>
  );
}
