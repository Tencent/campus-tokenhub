import { SkeletonCard } from '@/components/portal/Skeleton';

export default function MembersLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-5 w-64 rounded-control bg-cream-200" />
      <SkeletonCard />
      <SkeletonCard />
    </div>
  );
}
