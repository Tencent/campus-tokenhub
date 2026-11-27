'use client';

import { useEffect, useRef, useState } from 'react';
import {
  formatParamsJson,
  parseRequestParams,
  resolveContentBlocks,
  summarizeParamLine,
  type CallContent,
  type ContentBlock,
} from '@/lib/portal/call-detail';
import { appPath } from '@/lib/paths';
import type { CallLogRow } from './CallLogTable';

/** 正文接口超过这个时间还没回来就按失败处理 */
const CONTENT_TIMEOUT_MS = 8_000;

type ContentState =
  | { kind: 'loading' }
  | { kind: 'ready'; content: CallContent }
  | { kind: 'failed'; reason: 'timeout' | 'unauthorized' | 'error' };

const STATUS_LABEL: Record<CallLogRow['status'], string> = {
  success: '成功',
  error: '失败',
  cancelled: '已取消',
  incomplete: '未完成',
  other: '其他',
};

const FAILURE_TEXT: Record<Extract<ContentState, { kind: 'failed' }>['reason'], string> = {
  timeout: '正文读取超时，请关闭后重新打开详情',
  unauthorized: '登录已过期，请刷新页面后重试',
  error: '正文读取失败，请关闭后重新打开详情',
};

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-4">
      <dt className="w-[76px] shrink-0 text-xs leading-5 text-ink-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-all text-xs leading-5 text-ink-900">{value}</dd>
    </div>
  );
}

function ContentBox({ label, block }: { label: string; block: ContentBlock }) {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-[13px] font-medium leading-5 text-ink-900">{label}</h4>
      <div className="rounded-control border border-line bg-cream/40 px-3 py-2.5">
        {block.truncated && (
          <p className="mb-1 text-[11px] leading-4 text-brand-orange">内容已截断</p>
        )}
        <p
          className={`whitespace-pre-wrap break-words text-xs leading-[20px] ${
            block.kind === 'text' ? 'text-ink-700' : 'text-ink-500'
          }`}
        >
          {block.text}
        </p>
      </div>
    </section>
  );
}

/**
 * 调用详情抽屉。
 *
 * 元信息与请求参数来自表格行，立即可渲染；正文按需向门户接口取，
 * 失败只影响输入/输出两栏，不影响其余内容。
 */
export function CallDetailDrawer({ row, onClose }: { row: CallLogRow | null; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<ContentState>({ kind: 'loading' });

  // 父组件每次渲染都会传新的 onClose，用 ref 避免 effect 反复重绑
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const logId = row?.id ?? null;

  useEffect(() => {
    if (!logId) return;

    setState({ kind: 'loading' });

    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, CONTENT_TIMEOUT_MS);

    fetch(appPath(`/api/portal/calls/${encodeURIComponent(logId)}/content`), {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then(async (response) => {
        if (response.status === 401) {
          setState({ kind: 'failed', reason: 'unauthorized' });
          return;
        }
        if (!response.ok) throw new Error('content request failed');
        const content = (await response.json()) as CallContent;
        setState({ kind: 'ready', content });
      })
      .catch(() => {
        if (controller.signal.aborted && !timedOut) return;
        setState({ kind: 'failed', reason: timedOut ? 'timeout' : 'error' });
      })
      .finally(() => window.clearTimeout(timer));

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [logId]);

  // Esc 关闭
  useEffect(() => {
    if (!logId) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [logId]);

  // 打开时锁滚动并把焦点送进面板；行切换不重复抢焦点
  useEffect(() => {
    if (!logId) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [logId]);

  if (!row) return null;

  const blocks = resolveContentBlocks(state.kind === 'ready' ? state.content : null, {
    failed: state.kind === 'failed',
  });
  const parsedParams = parseRequestParams(row.requestBody);
  const rawParams = row.requestBody?.trim() ?? '';

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink-900/30"
      onClick={(event) => {
        // 只在点遮罩本身时关闭；面板内选中文本拖到外面不该误关
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="call-detail-title"
        tabIndex={-1}
        className="flex h-full w-full max-w-[560px] flex-col overflow-y-auto border-l border-line bg-white shadow-[-8px_0_24px_-8px_rgba(0,0,0,0.18)] outline-none focus-visible:outline-none"
      >
        <div className="flex items-start justify-between gap-3 px-6 pt-6">
          <h3 id="call-detail-title" className="text-base font-semibold leading-6 text-ink-900">
            调用详情
          </h3>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="-mr-2 -mt-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-500 transition hover:bg-cream-100 hover:text-ink-700"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
              <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex flex-col gap-[14px] px-6 py-6">
          <dl className="flex flex-col gap-2">
            <MetaRow label="时间" value={`${row.time} · ${STATUS_LABEL[row.status]}`} />
            <MetaRow label="模型" value={row.model} />
            <MetaRow label="使用的 Key" value={row.keyName} />
            <MetaRow
              label="Token 与消耗"
              value={`输入 ${row.inputTokens} · 输出 ${row.outputTokens} · ${row.points} 算力值 · ${row.latency}`}
            />
          </dl>

          <div className="h-px w-full bg-line" />

          {row.errorMessage && (
            <section className="flex flex-col gap-2">
              <h4 className="text-[13px] font-medium leading-5 text-ink-900">错误信息</h4>
              <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2.5 text-xs leading-[20px] text-danger">
                {row.errorMessage}
              </p>
            </section>
          )}

          {state.kind === 'loading' ? (
            <div className="flex flex-col gap-[14px]" aria-busy="true">
              {['输入内容', '输出内容'].map((label) => (
                <section key={label} className="flex flex-col gap-2">
                  <h4 className="text-[13px] font-medium leading-5 text-ink-900">{label}</h4>
                  <div className="h-[68px] animate-pulse rounded-control bg-cream-100" />
                </section>
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-[14px]">
              {state.kind === 'failed' && (
                <p className="rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2 text-xs leading-5 text-danger">
                  {FAILURE_TEXT[state.reason]}
                </p>
              )}
              <ContentBox label="输入内容" block={blocks.input} />
              <ContentBox label="输出内容" block={blocks.output} />
            </div>
          )}

          <section className="flex flex-col gap-2">
            <h4 className="text-[13px] font-medium leading-5 text-ink-900">请求参数</h4>
            <p className="break-all rounded-control bg-cream-100 px-3 py-2 font-mono text-[11px] leading-[18px] text-ink-700">
              {summarizeParamLine(row.requestBody)}
            </p>
            {rawParams !== '' && (
              <details className="rounded-control border border-line px-3 py-2">
                <summary className="cursor-pointer text-[11px] leading-4 text-ink-500">展开原始参数</summary>
                <pre className="scroll-x mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all text-[11px] leading-4 text-ink-600">
                  {parsedParams ? formatParamsJson(parsedParams) : '请求参数无法解析'}
                </pre>
              </details>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
