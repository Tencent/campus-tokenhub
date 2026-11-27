'use client';

import { useRouter, useSearchParams } from 'next/navigation';

/**
 * 趋势卡的模型 / 密钥筛选。
 *
 * 两者互斥：选了模型就把密钥清空，反之亦然——网关给的是两条独立序列，
 * 同时传没有「交集」语义，硬拼会让人误读。
 */
export function TrendFilters({
  models,
  keys,
}: {
  models: { id: string; name: string }[];
  keys: { id: string; name: string }[];
}) {
  const router = useRouter();
  const params = useSearchParams();
  const trendModel = params.get('tm') ?? 'all';
  const trendKey = params.get('tk') ?? 'all';

  function push(next: Record<string, string>): void {
    const merged = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value || value === 'all') merged.delete(key);
      else merged.set(key, value);
    }
    // 明细页码回到第一页，避免停在一个已不存在的页
    merged.set('page', '1');
    router.push(`?${merged.toString()}`);
  }

  const selectClass =
    'h-8 w-[132px] rounded-control border border-line bg-white px-2 text-xs text-ink-700 outline-none transition hover:border-ink-300 focus:border-brand-orange';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={trendModel}
        onChange={(event) => push({ tm: event.target.value, tk: 'all' })}
        aria-label="趋势按模型筛选"
        className={selectClass}
      >
        <option value="all">全部模型</option>
        {models.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>

      <select
        value={trendKey}
        onChange={(event) => push({ tk: event.target.value, tm: 'all' })}
        aria-label="趋势按密钥筛选"
        className={selectClass}
      >
        <option value="all">全部密钥</option>
        {keys.map((item) => (
          <option key={item.id} value={item.id}>
            {item.name}
          </option>
        ))}
      </select>
    </div>
  );
}
