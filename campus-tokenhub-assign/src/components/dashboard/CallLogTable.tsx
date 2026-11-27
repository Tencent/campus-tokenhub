'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { pageWindow } from '@/lib/portal/pagination';
import { CallDetailDrawer } from './CallDetailDrawer';

/** 就地刷新的兜底时长：请求失败或被新点击打断时，别让遮罩一直挂着 */
const PENDING_SAFETY_MS = 15_000;

export type CallLogRow = {
  id: string;
  time: string;
  model: string;
  keyName: string;
  inputTokens: string;
  outputTokens: string;
  points: string;
  latency: string;
  status: 'success' | 'error' | 'cancelled' | 'incomplete' | 'other';
  /** 网关脱敏后的请求体（无消息正文），抽屉「展开原始参数」展示 */
  requestBody: string | null;
  errorMessage: string | null;
};

const STATUS_LABEL: Record<CallLogRow['status'], string> = {
  success: '成功',
  error: '失败',
  cancelled: '已取消',
  incomplete: '未完成',
  other: '未知',
};

function StatusBadge({ status }: { status: CallLogRow['status'] }) {
  if (status === 'success') {
    return (
      <span className="inline-flex h-5 items-center rounded-[4px] bg-[#E8F5EE] px-1.5 text-[11px] font-medium leading-5 text-success">
        成功
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex h-5 items-center rounded-[4px] bg-[#FDECEA] px-1.5 text-[11px] font-medium leading-5 text-danger">
        失败
      </span>
    );
  }
  if (status === 'cancelled' || status === 'incomplete') {
    return (
      <span className="inline-flex h-5 items-center rounded-[4px] bg-cream-100 px-1.5 text-[11px] font-medium leading-5 text-ink-500">
        {STATUS_LABEL[status]}
      </span>
    );
  }
  return <span className="text-[11px] text-ink-500">{STATUS_LABEL[status]}</span>;
}

export function CallLogTable({
  rows,
  total,
  page,
  pageSize,
  range,
  status,
  model,
  models,
  degraded = false,
}: {
  rows: CallLogRow[];
  total: number;
  page: number;
  pageSize: number;
  /** 当前区间，分页链接要带上 */
  range: string;
  /** 当前状态筛选，分页链接要带上 */
  status: string;
  /** 当前模型筛选（all 或 model_id） */
  model: string;
  /** 可筛选的模型列表 */
  models: { id: string; name: string }[];
  /** 明细接口取数失败：展示提示而不是「没有记录」 */
  degraded?: boolean;
}) {
  const router = useRouter();
  const [openId, setOpenId] = useState<string | null>(null);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  /**
   * 就地刷新的等待标记（状态筛选 / 翻页 / 模型下拉）。
   *
   * 这几处只换 query，服务端要重新取数，等待期间表格还是旧数据；
   * 不做任何提示的话点了像没反应。新数据落地（page/status/model 变化）后自动清掉。
   */
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    setPending(null);
  }, [page, status, model]);

  useEffect(() => {
    if (pending === null) return;
    const timer = window.setTimeout(() => setPending(null), PENDING_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  function hrefFor(nextPage: number, nextStatus: string, nextModel = model): string {
    const params = new URLSearchParams({
      range,
      status: nextStatus,
      page: String(nextPage),
      model: nextModel,
    });
    return `?${params.toString()}`;
  }

  const filters = [
    { key: 'all', label: '全部状态' },
    { key: 'success', label: '成功' },
    { key: 'error', label: '失败' },
  ];

  /** 等新数据时把旧内容整体压暗：不然看起来像“点了但没变” */
  const bodyClass = `transition-opacity ${pending ? 'opacity-60' : ''}`;

  return (
    <div className="flex flex-col gap-3" aria-busy={pending !== null || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold leading-6 text-ink-900">调用明细</h2>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={model}
            onChange={(event) => {
              setPending('model');
              router.push(hrefFor(1, status, event.target.value));
            }}
            aria-label="按模型筛选"
            className="h-8 rounded-control border border-line bg-white px-2 text-xs text-ink-700 outline-none transition hover:border-ink-300 focus:border-brand-orange"
          >
            <option value="all">全部模型</option>
            {models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 rounded-control border border-line bg-white p-0.5">
            {filters.map((item) => (
              <Link
                key={item.key}
                href={hrefFor(1, item.key)}
                aria-current={status === item.key ? 'page' : undefined}
                aria-busy={pending === `status:${item.key}` || undefined}
                onClick={() => {
                  // 已经是这个筛选时不会再取数，不打等待标记，避免挂了 15s 才消
                  if (item.key === status) return;
                  setPending(`status:${item.key}`);
                }}
                className={`flex h-8 items-center rounded-[4px] px-2.5 text-xs transition ${
                  status === item.key
                    ? 'bg-brand-orange-soft font-medium text-brand-orange'
                    : 'text-ink-700 hover:bg-cream-100'
                }`}
              >
                {item.label}
              </Link>
            ))}
          </div>

          {/* 常驻占位：只在等待时显形，避免出现/消失时右侧按钮组跳动 */}
          <span
            className={`flex items-center gap-1.5 text-xs text-ink-500 transition-opacity ${
              pending ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <span
              aria-hidden
              className={`inline-block h-3 w-3 rounded-full border-[1.5px] border-ink-300 border-t-transparent ${
                pending ? 'animate-spin' : ''
              }`}
            />
            加载中
          </span>
        </div>
      </div>

      {degraded ? (
        <div
          className={`${bodyClass} rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-4 py-3 text-xs leading-5 text-danger`}
        >
          调用明细暂时读取失败，可以稍后刷新本页；上面的汇总与图表不受影响。
        </div>
      ) : rows.length === 0 ? (
        <div className={`${bodyClass} rounded-control bg-cream/50 px-4 py-12 text-center`}>
          <p className="text-sm font-medium text-ink-900">这段时间没有调用记录</p>
          <p className="mt-1 text-xs text-ink-500">换个时间区间，或先在「接入指南」里发一条测试请求。</p>
        </div>
      ) : (
        <div className={`${bodyClass} scroll-x overflow-x-auto`}>
          <table className="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {['时间', '模型', '使用的 Key', '输入 Token', '输出 Token', '消耗算力值', '耗时', '状态', '操作'].map(
                  (title) => (
                    <th
                      key={title}
                      scope="col"
                      className="whitespace-nowrap px-2 py-2.5 text-xs font-normal leading-5 text-ink-500 first:pl-0 last:pr-0 last:text-right"
                    >
                      {title}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-cream-200 last:border-0">
                  <td className="whitespace-nowrap px-2 py-3 text-xs leading-5 text-ink-700 first:pl-0">{row.time}</td>
                  <td className="max-w-[180px] truncate px-2 py-3 text-xs leading-5 text-ink-900">{row.model}</td>
                  <td className="max-w-[160px] truncate px-2 py-3 text-xs leading-5 text-ink-700">{row.keyName}</td>
                  <td className="px-2 py-3 text-xs leading-5 tabular-nums text-ink-700">{row.inputTokens}</td>
                  <td className="px-2 py-3 text-xs leading-5 tabular-nums text-ink-700">{row.outputTokens}</td>
                  <td className="px-2 py-3 text-xs leading-5 tabular-nums text-ink-900">{row.points}</td>
                  <td className="px-2 py-3 text-xs leading-5 tabular-nums text-ink-700">{row.latency}</td>
                  <td className="px-2 py-3">
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="px-2 py-3 text-right last:pr-0">
                    <button
                      type="button"
                      onClick={() => setOpenId((prev) => (prev === row.id ? null : row.id))}
                      aria-haspopup="dialog"
                      aria-expanded={openId === row.id}
                      className="text-xs leading-5 text-brand-orange transition hover:underline"
                    >
                      查看详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <CallDetailDrawer row={rows.find((item) => item.id === openId) ?? null} onClose={() => setOpenId(null)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs leading-5 text-ink-500">
          共 <span className="font-medium text-ink-700 tabular-nums">{total.toLocaleString('zh-CN')}</span> 条调用记录
        </p>
        {pageCount > 1 && (
          <div className="flex items-center gap-1">
            <Link
              href={hrefFor(Math.max(1, page - 1), status)}
              aria-label="上一页"
              aria-disabled={page === 1}
              onClick={() => {
                if (page === 1) return;
                setPending(`page:${Math.max(1, page - 1)}`);
              }}
              className={`flex h-7 w-7 items-center justify-center rounded-control border border-line bg-white text-xs transition ${
                page === 1 ? 'pointer-events-none text-ink-300' : 'text-ink-700 hover:border-ink-300'
              }`}
            >
              ‹
            </Link>
            {pageWindow(page, pageCount).map((item, position) =>
              item === 'gap' ? (
                <span
                  key={`gap-${position}`}
                  aria-hidden
                  className="flex h-7 w-5 items-center justify-center text-xs text-ink-400"
                >
                  …
                </span>
              ) : (
                <Link
                  key={item}
                  href={hrefFor(item, status)}
                  aria-current={item === page ? 'page' : undefined}
                  aria-busy={pending === `page:${item}` || undefined}
                  onClick={() => {
                    if (item === page) return;
                    setPending(`page:${item}`);
                  }}
                  className={`flex h-7 min-w-[28px] items-center justify-center rounded-control px-1.5 text-xs tabular-nums transition ${
                    item === page
                      ? 'bg-brand-orange font-medium text-white'
                      : 'border border-line bg-white text-ink-700 hover:border-ink-300'
                  }`}
                >
                  {item}
                </Link>
              )
            )}
            <Link
              href={hrefFor(Math.min(pageCount, page + 1), status)}
              aria-label="下一页"
              aria-disabled={page === pageCount}
              onClick={() => {
                if (page === pageCount) return;
                setPending(`page:${Math.min(pageCount, page + 1)}`);
              }}
              className={`flex h-7 w-7 items-center justify-center rounded-control border border-line bg-white text-xs transition ${
                page === pageCount ? 'pointer-events-none text-ink-300' : 'text-ink-700 hover:border-ink-300'
              }`}
            >
              ›
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
