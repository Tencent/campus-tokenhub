'use client';

import { useEffect, useRef, useState } from 'react';

function IconCopy() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="5" y="5" width="7.2" height="7.2" rx="1.4" stroke="currentColor" strokeWidth="1.4" />
      <path d="M9 3.4V2.9A1.1 1.1 0 007.9 1.8H2.9A1.1 1.1 0 001.8 2.9v5A1.1 1.1 0 002.9 9h.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M2.8 7.2l2.9 2.9 5.5-6.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type CopyState = 'idle' | 'copied' | 'error';

/**
 * 复制按钮：优先用 Clipboard API，失败回退到隐藏 textarea（HTTP 部署下也可能没有 clipboard）。
 *
 * `resolveValue` 用于「明文不在页面里」的场景（如 API Key）：点的时候才去服务端取，
 * 取不到就显示「复制失败」，不再静默无反应。
 */
export function CopyButton({
  value,
  resolveValue,
  label = '复制',
  className = '',
  iconOnly = false,
}: {
  value?: string;
  resolveValue?: () => Promise<string>;
  label?: string;
  className?: string;
  /** 只显示图标：用于卡片这类横向空间紧张的位置 */
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<CopyState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 卸载时清掉「已复制」的回退定时器，避免对已卸载组件 setState
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  async function copy(): Promise<void> {
    try {
      const text = resolveValue ? await resolveValue() : (value ?? '');
      if (!text) throw new Error('empty value');

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }

      setState('copied');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setState('idle'), 1500);
    } catch {
      setState('error');
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setState('idle'), 2500);
    }
  }

  const text = state === 'copied' ? '已复制' : state === 'error' ? '复制失败' : label;

  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={iconOnly ? text : undefined}
      title={iconOnly ? text : undefined}
      aria-live="polite"
      className={
        className ||
        `rounded-full border px-3 py-1 text-xs font-medium transition ${
          state === 'copied'
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : state === 'error'
              ? 'border-rose-200 bg-rose-50 text-rose-700'
              : 'border-line bg-white text-ink-700 hover:border-ink-300 hover:text-ink-900'
        }`
      }
    >
      {iconOnly ? (
        <span aria-hidden>{state === 'copied' ? <IconCheck /> : <IconCopy />}</span>
      ) : (
        text
      )}
    </button>
  );
}
