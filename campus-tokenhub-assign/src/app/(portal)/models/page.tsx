import { Suspense } from 'react';
import { getCatalog, listModelMeta, formatPricing } from '@/lib/gateway/catalog';
import { describeModelCapabilities, resolveCatalogCategories } from '@/lib/gateway/catalog-category';
import { formatPointsPrice } from '@/lib/portal/points';
import { formatTokens as formatTokensLib } from '@/lib/portal/usage-format';
import type { CatalogModel } from '@/lib/gateway/types';
import ModelCatalog, { type ModelCardData } from '@/components/models/ModelCatalog';
import { ModelGridSkeleton } from '@/components/portal/Skeleton';

export const dynamic = 'force-dynamic';

/** 上架 30 天内算新模型 */
const NEW_BADGE_DAYS = 30;

/** 「热门」的约定：网关模型 tags 里带这个值，运营在管理台勾选即生效 */
const HOT_TAG = 'hot';

/** 统一走 `lib/portal/usage-format`：四处各写一份时 K/M 的口径会漂移 */
function formatTokens(value: number | null): string {
  return value ? formatTokensLib(value) : '—';
}

/** 金额（元）→ 算力值文案；单价很小，不能取整成 0 */
function pointsLabel(value: number | null): string {
  return value === null || value === undefined ? '—' : formatPointsPrice(value);
}

function formatReleasedAt(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isNewModel(iso: string | null, at: Date): boolean {
  if (!iso) return false;
  const released = new Date(iso).getTime();
  if (Number.isNaN(released)) return false;
  return at.getTime() - released <= NEW_BADGE_DAYS * 86_400_000;
}

/** 目录模型 → 卡片数据：价格与时段在服务端算好，分类按模态与命名推导。 */
function toCardData(model: CatalogModel, at: Date, meta: { note: string | null; releasedAt: string | null } | undefined): ModelCardData {
  const pricing = formatPricing(model, at);
  const categories = resolveCatalogCategories(model);
  const primary = categories[0];

  return {
    id: model.id,
    href: `/models/${model.id.split('/').map(encodeURIComponent).join('/')}`,
    name: model.display_name || model.id,
    vendor: model.vendor || '未知厂商',
    categories,
    capabilities: describeModelCapabilities(model),
    contextText: formatTokens(model.context_window),
    maxText: formatTokens(model.max_tokens),
    price:
      primary === 'image' || primary === 'video'
        ? { kind: 'image', perImage: pointsLabel(pricing.price.imagePrice) }
        : {
            kind: 'token',
            input: pointsLabel(pricing.price.inputPerMillion),
            output: pointsLabel(pricing.price.outputPerMillion),
          },
    scheduleHint: pricing.scheduleHint,
    providerNote: pricing.providerNote,
    note: meta?.note ?? null,
    releasedAt: formatReleasedAt(meta?.releasedAt ?? null),
    isNew: isNewModel(meta?.releasedAt ?? null, at),
    // 运营在网关模型 tags 里标 `hot` 即为热门
    isHot: (model.tags ?? []).some((tag) => tag.trim().toLowerCase() === HOT_TAG),
  };
}

/** 数据区：模型目录拉回来后替换骨架 */
async function ModelList() {
  // 目录与简介互不依赖，并发取；串行会白白多等一轮网关往返
  const [snapshot, metaMap] = await Promise.all([
    getCatalog().catch(() => null),
    // 简介与上架日期只在管理端有；读不到时返回空 Map，集市照常展示
    listModelMeta(),
  ]);

  if (!snapshot) {
    return (
      <div className="rounded-card border border-[#F5C2BE] bg-[#FDECEA] p-6 text-sm text-danger">
        暂时无法获取模型列表，请稍后刷新页面。
      </div>
    );
  }

  const at = new Date();
  const cards = snapshot.models.map((model) => toCardData(model, at, metaMap.get(model.id)));

  if (cards.length === 0) {
    return (
      <div className="rounded-card border border-line bg-white p-12 text-center">
        <p className="text-sm font-medium text-ink-900">网关还没有可用的模型</p>
        <p className="mt-1 text-xs text-ink-500">模型上线在 Octafuse 网关管理后台维护，上线后这里会自动出现。</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {snapshot.stale && (
        <div className="rounded-control border border-brand-yellow/40 bg-brand-yellow-soft px-4 py-2 text-xs leading-relaxed text-ink-700">
          模型信息可能不是最新（暂时连不上服务，正在展示缓存）。模型变更通常延迟约 1 分钟生效。
        </div>
      )}

      <ModelCatalog models={cards} />

    </div>
  );
}

export default function ModelsPage() {
  return (
    <Suspense fallback={<ModelGridSkeleton />}>
      <ModelList />
    </Suspense>
  );
}
