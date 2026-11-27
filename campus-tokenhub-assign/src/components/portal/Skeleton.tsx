import type { ReactNode } from 'react';

/** 骨架占位不单独动画，所有子块由最外层加载区域统一淡入与脉动。 */
export function SkeletonBlock({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`rounded-control bg-cream-200/70 ${className}`} />;
}

/** 保留布局高度，快速请求不闪骨架；嵌套区域的动画由 CSS 禁用。 */
export function SkeletonRegion({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div aria-busy="true" aria-label="正在加载页面数据" className={`skeleton-region ${className}`}>
      {children}
    </div>
  );
}

/** 单张额度卡占位；与调用记录组合时共用外层加载区域。 */
export function SkeletonCard({ rows = 3, className = '' }: { rows?: number; className?: string }) {
  return (
    <section className={`rounded-card border border-line bg-white p-6 shadow-card ${className}`}>
      <SkeletonBlock className="h-3 w-20" />
      <SkeletonBlock className="mt-4 h-8 w-28" />
      <div className="mt-4 space-y-2.5">
        {Array.from({ length: rows }).map((_, index) => (
          <SkeletonBlock key={index} className="h-3 w-full" />
        ))}
      </div>
    </section>
  );
}

/** 指南列表占位，行高贴近真实模型清单。 */
export function ListCardSkeleton({ rows = 4, className = '' }: { rows?: number; className?: string }) {
  return (
    <SkeletonRegion className={className}>
      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <SkeletonBlock className="h-5 w-32" />
        <div className="mt-3 space-y-0.5">
          {Array.from({ length: rows }).map((_, index) => (
            <SkeletonBlock key={index} className="h-14 w-full" />
          ))}
        </div>
        <SkeletonBlock className="mt-2 h-4 w-full" />
      </section>
    </SkeletonRegion>
  );
}

/** 模型网格始终只在父容器运行一次脉动。 */
export function ModelGridSkeleton() {
  return (
    <SkeletonRegion className="space-y-5">
      <SkeletonBlock className="ml-auto h-4 w-24" />
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <div key={index} className="rounded-card border border-line bg-white p-5 shadow-card">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="mt-2 h-3 w-24" />
            <div className="mt-4 flex gap-1.5">
              <SkeletonBlock className="h-5 w-12 rounded-full" />
              <SkeletonBlock className="h-5 w-12 rounded-full" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <SkeletonBlock className="h-8" />
              <SkeletonBlock className="h-8" />
            </div>
            <SkeletonBlock className="mt-4 h-3 w-full" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}

/** 接入指南顶部「接入信息 + 快速验证」占位，模型 ID 依赖网关目录 */
export function GuideInfoSkeleton() {
  return (
    <SkeletonRegion className="space-y-5">
      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <SkeletonBlock className="h-4 w-20" />
        <div className="mt-4 space-y-4">
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-10 w-full" />
          <SkeletonBlock className="h-10 w-full" />
        </div>
      </section>
      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <SkeletonBlock className="h-4 w-24" />
        <SkeletonBlock className="mt-3 h-36 w-full" />
      </section>
    </SkeletonRegion>
  );
}

/** 与调试台真实三栏栅格一致。 */
export function PlaygroundGridSkeleton() {
  return (
    <SkeletonRegion className="grid gap-4 xl:grid-cols-[260px_minmax(0,1fr)_minmax(0,1fr)]">
      <div className="rounded-card border border-line bg-white p-5 shadow-card">
        <SkeletonBlock className="h-3 w-16" />
        <SkeletonBlock className="mt-3 h-9 w-full" />
        <SkeletonBlock className="mt-4 h-24 w-full" />
      </div>
      <div className="rounded-card border border-line bg-white p-5 shadow-card">
        <SkeletonBlock className="h-3 w-20" />
        <SkeletonBlock className="mt-4 h-10 w-full" />
        <SkeletonBlock className="mt-4 h-24 w-full" />
        <SkeletonBlock className="mt-4 h-9 w-28 rounded-full" />
      </div>
      <div className="rounded-card border border-line bg-white p-5 shadow-card">
        <SkeletonBlock className="h-3 w-20" />
        <SkeletonBlock className="mt-4 h-40 w-full" />
        <SkeletonBlock className="mt-4 h-24 w-full" />
      </div>
    </SkeletonRegion>
  );
}

export type PageSkeletonVariant = 'overview' | 'models' | 'detail' | 'playground' | 'guide';

const PAGE_TITLES = {
  overview: '我的算力',
  models: '模型',
  playground: '在线调试台',
  guide: '接入指南',
};

/** 已知路由直接显示真实标题，避免先空标题骨架再切一次页面外壳。 */
function PageHeader({ variant }: { variant: Exclude<PageSkeletonVariant, 'detail'> }) {
  // 调试台正文只有一行说明（标题在顶栏），骨架不能先渲染一个大标题再塌下去
  if (variant === 'playground') {
    return <SkeletonBlock className="h-5 w-full max-w-xl" />;
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-900">{PAGE_TITLES[variant]}</h1>
      <div className="mt-1 h-5" />
    </div>
  );
}

/** 页面级占位保留真实容器宽度；标题不参与骨架动画。 */
export function PageSkeleton({ variant = 'overview' }: { variant?: PageSkeletonVariant }) {
  if (variant === 'detail') {
    return (
      <SkeletonRegion className="mx-auto max-w-3xl space-y-5">
        <div>
          <SkeletonBlock className="h-4 w-24" />
          <SkeletonBlock className="mt-2 h-8 w-48" />
          <SkeletonBlock className="mt-1 h-4 w-40" />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <SkeletonCard rows={4} />
          <SkeletonCard rows={4} />
        </div>
        <ListCardSkeleton rows={2} />
      </SkeletonRegion>
    );
  }

  const width = variant === 'guide' ? 'mx-auto max-w-3xl' : '';
  let content: ReactNode;
  if (variant === 'models') {
    content = <ModelGridSkeleton />;
  } else if (variant === 'playground') {
    content = <PlaygroundGridSkeleton />;
  } else if (variant === 'guide') {
    content = (
      <SkeletonRegion className="space-y-5">
        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink-900">快速验证</h2>
          <SkeletonBlock className="mt-3 h-36 w-full" />
        </section>
        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink-900">接入信息</h2>
          <div className="mt-4 space-y-4">
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
            <SkeletonBlock className="h-10 w-full" />
          </div>
        </section>
        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink-900">一键接入 WorkBuddy</h2>
          <SkeletonBlock className="mt-3 h-48 w-full" />
          <SkeletonBlock className="mt-3 h-16 w-full" />
        </section>
        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink-900">手动接入 WorkBuddy</h2>
          <SkeletonBlock className="mt-3 h-64 w-full" />
        </section>
        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <h2 className="text-sm font-semibold text-ink-900">常见问题</h2>
          <SkeletonBlock className="mt-3 h-64 w-full" />
        </section>
      </SkeletonRegion>
    );
  } else {
    content = (
      <SkeletonRegion className="space-y-5">
        <SkeletonCard rows={2} />
        <SkeletonCard rows={5} />
      </SkeletonRegion>
    );
  }

  return (
    <div aria-busy="true" className={`space-y-5 ${width}`}>
      <PageHeader variant={variant} />
      {content}
    </div>
  );
}
