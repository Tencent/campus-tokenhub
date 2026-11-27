'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { CopyButton } from '@/components/ui/CopyButton';
import { ModelIcon } from '@/components/models/ModelIcon';
import {
  CATALOG_CATEGORY_META,
  CATALOG_CATEGORY_ORDER,
  type CatalogCategoryKey,
} from '@/lib/gateway/catalog-category';

/**
 * 卡片展示数据。
 *
 * 价格、时段倍率等都在服务端算好再传进来：`@/lib/gateway/catalog` 会引用网关客户端，
 * 不能进客户端 bundle；顺带避免 hydration 时重算价格出现首屏数字跳变。
 */
export type ModelCardData = {
  id: string;
  href: string;
  name: string;
  vendor: string;
  /** 归属分类（可多个：大语言模型与其子集会重叠） */
  categories: CatalogCategoryKey[];
  /** 输入能力标签，如「图片理解」「纯文本」 */
  capabilities: string[];
  contextText: string;
  maxText: string;
  /** 价格已换算成「算力值」 */
  price: { kind: 'image'; perImage: string } | { kind: 'token'; input: string; output: string };
  scheduleHint: string | null;
  providerNote: string | null;
  /** 一句话简介，取自网关模型备注 */
  note: string | null;
  /** 上架日期，已格式化为 2026-10-28 */
  releasedAt: string | null;
  /** 上架 30 天内算新模型 */
  isNew: boolean;
  /** 网关 tags 里带 `hot` 的模型（运营手动标记的热门） */
  isHot: boolean;
};

type FilterKey = 'all' | CatalogCategoryKey;

const PAGE_SIZE = 12;

const ALL_TAB: { key: FilterKey; label: string; hint: string } = {
  key: 'all',
  label: '全部',
  hint: '管理员开放的模型全部展示。',
};

function IconArrow() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2.5 6h6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6.25 3l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <ellipse cx="7" cy="7" rx="4.6" ry="4.6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.4 10.4L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function IconGrid() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="2" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="2" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="5" height="5" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function IconList() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

const COPY_CLASS =
  'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-control border border-line bg-white text-ink-500 transition hover:border-ink-300 hover:text-ink-900';

/** 品牌图标：与 learning-buddy-web 同一套模型 logo，认不出品牌时回退默认图标 */
function VendorMark({ vendor, modelId, modelName }: { vendor: string; modelId: string; modelName: string }) {
  return <ModelIcon id={modelId} name={modelName || vendor} />;
}

function priceText(model: ModelCardData): string {
  if (model.price.kind === 'image') return `${model.price.perImage} 算力值 / 张`;
  return `输入 ${model.price.input} · 输出 ${model.price.output} 算力值 / 百万 tokens`;
}

function CapabilityTags({ items }: { items: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="rounded-[4px] bg-brand-orange-soft px-1.5 py-0.5 text-[11px] leading-4 text-brand-orange"
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function NewBadge() {
  return (
    <span className="h-5 shrink-0 rounded-[4px] bg-[#E8F5EE] px-1.5 text-[11px] font-medium leading-5 text-success">
      新上线
    </span>
  );
}

/** 热门：运营在网关模型 tags 里标 `hot`，颜色取设计稿的「热门」橙 */
function HotBadge() {
  return (
    <span className="h-5 shrink-0 rounded-[4px] bg-[#FDF2E3] px-1.5 text-[11px] font-medium leading-5 text-brand-yellow">
      热门
    </span>
  );
}

/** 卡片视图 */
function ModelCard({ model }: { model: ModelCardData }) {
  return (
    <article className="group relative flex flex-col gap-3 rounded-card border border-line bg-white p-[18px] transition-[border-color,box-shadow] duration-150 hover:border-brand-orange/40 hover:shadow-card-hover">
      {/* 整卡可点：透明覆盖层 + 内容 pointer-events-none，只有复制按钮重新接收点击 */}
      <Link href={model.href} aria-label={`查看 ${model.name} 详情`} className="absolute inset-0 z-0 rounded-card" />

      <div className="pointer-events-none relative z-[1] flex items-center gap-2.5">
        <VendorMark vendor={model.vendor} modelId={model.id} modelName={model.name} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold leading-5 text-ink-900">{model.name}</h3>
        {model.isHot && <HotBadge />}
        {model.isNew && <NewBadge />}
      </div>

      <div className="pointer-events-none relative z-[1] flex items-center gap-1.5">
        <code className="min-w-0 truncate font-mono text-[11px] leading-4 text-ink-500">{model.id}</code>
        <span className="pointer-events-auto">
          <CopyButton value={model.id} label="复制模型 ID" iconOnly className={COPY_CLASS} />
        </span>
      </div>

      <div className="pointer-events-none relative z-[1]">
        <CapabilityTags items={model.capabilities} />
      </div>

      <p className="pointer-events-none relative z-[1] text-xs leading-5 text-ink-500">
        上下文 {model.contextText} · 输出 {model.maxText}
      </p>

      {model.note && (
        <p className="pointer-events-none relative z-[1] line-clamp-2 text-xs leading-5 text-ink-700">{model.note}</p>
      )}

      <div className="pointer-events-none relative z-[1] mt-auto h-px w-full bg-[#EDEFF3]" />

      <div className="pointer-events-none relative z-[1] flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs leading-5 text-ink-900">{priceText(model)}</p>
          {model.releasedAt && <p className="mt-0.5 text-[11px] leading-4 text-ink-500">上架 {model.releasedAt}</p>}
          {model.scheduleHint && <p className="mt-0.5 text-[11px] leading-4 text-ink-500">{model.scheduleHint}</p>}
          {model.providerNote && <p className="mt-0.5 text-[11px] leading-4 text-success">{model.providerNote}</p>}
        </div>
        <span className="flex shrink-0 items-center gap-1 text-xs leading-5 text-brand-orange">
          用它接入
          <IconArrow />
        </span>
      </div>
    </article>
  );
}

/** 列表视图：信息密度更高，筛选后快速浏览 */
function ModelRow({ model }: { model: ModelCardData }) {
  return (
    <article className="group relative flex items-center gap-4 rounded-card border border-line bg-white px-4 py-3 transition hover:border-brand-orange/40">
      <Link href={model.href} aria-label={`查看 ${model.name} 详情`} className="absolute inset-0 z-0 rounded-card" />

      <span className="pointer-events-none relative z-[1]">
        <VendorMark vendor={model.vendor} modelId={model.id} modelName={model.name} />
      </span>

      <div className="pointer-events-none relative z-[1] min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold text-ink-900">{model.name}</h3>
          {model.isHot && <HotBadge />}
          {model.isNew && <NewBadge />}
        </div>
        <code className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-ink-500">{model.id}</code>
      </div>

      <div className="pointer-events-none relative z-[1] hidden shrink-0 md:block">
        <CapabilityTags items={model.capabilities} />
      </div>

      <p className="pointer-events-none relative z-[1] hidden w-[280px] shrink-0 whitespace-nowrap text-right text-xs leading-5 text-ink-900 lg:block">
        {priceText(model)}
      </p>

      <span className="pointer-events-none relative z-[1] flex shrink-0 items-center gap-1 text-xs text-brand-orange">
        用它接入
        <IconArrow />
      </span>
    </article>
  );
}

export default function ModelCatalog({ models }: { models: ModelCardData[] }) {
  const [category, setCategory] = useState<FilterKey>('all');
  const [query, setQuery] = useState('');
  const [vendor, setVendor] = useState('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const result = {} as Record<CatalogCategoryKey, number>;
    for (const key of CATALOG_CATEGORY_ORDER) result[key] = 0;
    for (const model of models) {
      for (const key of model.categories) result[key] += 1;
    }
    return result;
  }, [models]);

  const tabs = useMemo(() => {
    const present = CATALOG_CATEGORY_ORDER.filter((key) => counts[key] > 0).map((key) => ({
      key: key as FilterKey,
      label: CATALOG_CATEGORY_META[key].label,
      hint: CATALOG_CATEGORY_META[key].hint,
    }));
    return [ALL_TAB, ...present];
  }, [counts]);

  const vendors = useMemo(() => {
    const set = new Set(models.map((model) => model.vendor).filter(Boolean));
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [models]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return models.filter((model) => {
      if (category !== 'all' && !model.categories.includes(category)) return false;
      if (vendor !== 'all' && model.vendor !== vendor) return false;
      if (!keyword) return true;
      return (
        model.name.toLowerCase().includes(keyword) ||
        model.id.toLowerCase().includes(keyword) ||
        model.vendor.toLowerCase().includes(keyword)
      );
    });
  }, [models, category, vendor, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  /** 任何筛选条件变化都要回到第一页，否则会停在一个空页 */
  function resetTo(next: () => void): void {
    next();
    setPage(1);
  }

  function countOf(key: FilterKey): number {
    return key === 'all' ? models.length : counts[key] ?? 0;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* 分类标签：未选中是纯文字，选中才是胶囊 */}
      <div role="tablist" aria-label="模型分类" className="flex min-h-10 flex-wrap items-center gap-x-5 gap-y-1">
        {tabs.map((tab) => {
          const active = category === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              title={tab.hint}
              aria-selected={active}
              onClick={() => resetTo(() => setCategory(tab.key))}
              className={
                active
                  ? 'flex h-8 items-center rounded-control bg-brand-orange-soft px-3 text-[13px] font-medium text-brand-orange'
                  : 'flex h-8 items-center text-[13px] text-ink-500 transition hover:text-ink-900'
              }
            >
              {tab.label} {countOf(tab.key)}
            </button>
          );
        })}
      </div>

      {/* 筛选行 */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative flex h-9 w-full items-center sm:w-[280px]">
          <span className="pointer-events-none absolute left-3 text-ink-500">
            <IconSearch />
          </span>
          <input
            type="search"
            value={query}
            onChange={(event) => resetTo(() => setQuery(event.target.value))}
            placeholder="搜索模型名称或 ID"
            aria-label="搜索模型名称或 ID"
            className="h-9 w-full rounded-control border border-line bg-white pl-9 pr-3 text-[13px] text-ink-900 outline-none transition placeholder:text-ink-400 hover:border-ink-300 focus:border-brand-orange"
          />
        </label>

        <select
          value={vendor}
          onChange={(event) => resetTo(() => setVendor(event.target.value))}
          aria-label="按厂商筛选"
          className="h-9 w-[132px] rounded-control border border-line bg-white px-2 text-[13px] text-ink-700 outline-none transition hover:border-ink-300 focus:border-brand-orange"
        >
          <option value="all">全部厂商</option>
          {vendors.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>

        <div className="ml-auto flex items-center gap-1" role="group" aria-label="视图切换">
          <button
            type="button"
            aria-pressed={view === 'grid'}
            aria-label="卡片视图"
            onClick={() => setView('grid')}
            className={`flex h-7 w-7 items-center justify-center rounded-control transition ${
              view === 'grid' ? 'bg-brand-orange-soft text-brand-orange' : 'text-ink-500 hover:bg-cream-100'
            }`}
          >
            <IconGrid />
          </button>
          <button
            type="button"
            aria-pressed={view === 'list'}
            aria-label="列表视图"
            onClick={() => setView('list')}
            className={`flex h-7 w-7 items-center justify-center rounded-control transition ${
              view === 'list' ? 'bg-brand-orange-soft text-brand-orange' : 'text-ink-500 hover:bg-cream-100'
            }`}
          >
            <IconList />
          </button>
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-card border border-line bg-white px-6 py-14 text-center">
          <p className="text-sm font-medium text-ink-900">没有匹配的模型</p>
          <p className="mt-1 text-xs leading-5 text-ink-500">换个关键词，或把筛选条件清空。</p>
          <button
            type="button"
            onClick={() =>
              resetTo(() => {
                setQuery('');
                setVendor('all');
                setCategory('all');
              })
            }
            className="mt-4 h-9 rounded-control border border-line bg-white px-3.5 text-[13px] text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
          >
            清空筛选
          </button>
        </div>
      ) : view === 'grid' ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((model) => (
            <ModelCard key={model.id} model={model} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {visible.map((model) => (
            <ModelRow key={model.id} model={model} />
          ))}
        </div>
      )}

      {/* 分页 */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="text-xs leading-5 text-ink-500">
          共 <span className="font-medium text-ink-700 tabular-nums">{filtered.length}</span> 个模型
        </p>
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
              className="flex h-7 w-7 items-center justify-center rounded-control border border-line bg-white text-xs text-ink-700 transition hover:border-ink-300 disabled:cursor-not-allowed disabled:text-ink-300"
              aria-label="上一页"
            >
              ‹
            </button>
            {Array.from({ length: pageCount }, (_, index) => index + 1).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setPage(item)}
                aria-current={item === safePage ? 'page' : undefined}
                className={`flex h-7 min-w-[28px] items-center justify-center rounded-control px-1.5 text-xs tabular-nums transition ${
                  item === safePage
                    ? 'bg-brand-orange font-medium text-white'
                    : 'border border-line bg-white text-ink-700 hover:border-ink-300'
                }`}
              >
                {item}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPage(Math.min(pageCount, safePage + 1))}
              disabled={safePage === pageCount}
              className="flex h-7 w-7 items-center justify-center rounded-control border border-line bg-white text-xs text-ink-700 transition hover:border-ink-300 disabled:cursor-not-allowed disabled:text-ink-300"
              aria-label="下一页"
            >
              ›
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
