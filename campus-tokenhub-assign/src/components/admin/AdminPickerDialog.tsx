'use client';

import { useEffect, useRef, useState } from 'react';
import { appPath } from '@/lib/paths';
import type { AdminCandidate } from '@/lib/admin/types';

type Props = {
  /** 已在名单里的身份：列表里置灰并标注，避免重复添加 */
  existingSubs: string[];
  /** 空关键字时的初始候选（页面已经取过，弹窗不必再打一次网关） */
  initialCandidates: AdminCandidate[];
  /** 保存成功：回传最新名单与本次选中的候选（页面用来补姓名） */
  onSaved: (subs: string[], added: AdminCandidate[]) => void;
  onClose: () => void;
};

type CandidateResponse = { candidates?: AdminCandidate[]; error?: string };
type ApiResponse = { subs?: string[]; error?: string };

/** 输入停顿多久后搜索，避免每敲一个字都打网关 */
const SEARCH_DEBOUNCE_MS = 250;

function candidateLabel(candidate: AdminCandidate): string {
  return candidate.name === candidate.sub ? candidate.sub : candidate.name;
}

/**
 * 添加管理员弹窗：搜索 → 勾选多个 → 保存才提交。
 *
 * 常规做法（对齐云控制台的「添加成员」）：弹窗里搜人、多选、底部显示已选，
 * 点保存才发一次写请求；中途取消不落任何数据。
 */
export function AdminPickerDialog({ existingSubs, initialCandidates, onSaved, onClose }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [keyword, setKeyword] = useState('');
  const [results, setResults] = useState<AdminCandidate[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AdminCandidate[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedKeyword = keyword.trim();
  const options = results ?? initialCandidates;
  const selectedSubs = new Set(selected.map((item) => item.sub));

  // 搜索：关键字为空时回到初始候选，不请求后端
  useEffect(() => {
    if (!trimmedKeyword) {
      setResults(null);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearching(true);
      fetch(
        appPath(`/api/portal/admins/candidates?q=${encodeURIComponent(trimmedKeyword)}`),
        { signal: controller.signal }
      )
        .then(async (response) => {
          const payload = (await response.json().catch(() => ({}))) as CandidateResponse;
          if (!response.ok) {
            setError(payload.error ?? '搜索失败，请稍后重试');
            return;
          }
          setError(null);
          setResults(payload.candidates ?? []);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError('网络异常，请稍后重试');
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmedKeyword]);

  // Esc 关闭 + 锁滚动 + 焦点送进搜索框
  /**
   * 用 ref 保存 onClose：父组件用内联箭头函数传它，若直接放进 effect 依赖，
   * 父组件每次重渲染都会重新加监听、重置 body.overflow 并把焦点抢回搜索框。
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    inputRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  function toggle(candidate: AdminCandidate): void {
    setSelected((previous) =>
      previous.some((item) => item.sub === candidate.sub)
        ? previous.filter((item) => item.sub !== candidate.sub)
        : [...previous, candidate]
    );
  }

  async function save(): Promise<void> {
    if (selected.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(appPath('/api/portal/admins'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subs: selected.map((item) => item.sub) }),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiResponse;
      if (!response.ok) {
        setError(payload.error ?? '保存失败，请稍后重试');
        return;
      }
      onSaved(payload.subs ?? [...existingSubs, ...selected.map((item) => item.sub)], selected);
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
      role="presentation"
      onClick={(event) => {
        // 只在点遮罩本身时关闭；弹窗内拖选文字拖到外面不该误关
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-picker-title"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl bg-white shadow-[0_8px_24px_-2px_rgba(0,0,0,0.18)]"
      >
        <div className="flex items-start justify-between gap-3 px-6 pb-3 pt-5">
          <div>
            <h3 id="admin-picker-title" className="text-base font-semibold leading-6 text-ink-900">
              添加全局管理员
            </h3>
            <p className="mt-1 text-xs leading-5 text-ink-500">
              可搜索并勾选多人，点「保存」后一次性生效。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="-mr-2 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-500 transition hover:bg-cream-100 hover:text-ink-700"
          >
            ×
          </button>
        </div>

        <div className="px-6">
          <div className="flex items-center gap-2 rounded-control border border-line px-3 py-1.5 transition focus-within:border-brand-orange focus-within:ring-4 focus-within:ring-brand-orange/15 hover:border-ink-300">
            <input
              ref={inputRef}
              type="search"
              className="w-full bg-transparent text-sm text-ink-900 outline-none placeholder:text-ink-500 disabled:opacity-60"
              placeholder="搜索姓名 / 邮箱 / school_id:user_id"
              value={keyword}
              maxLength={60}
              disabled={saving}
              onChange={(event) => setKeyword(event.target.value)}
            />
            {searching && <span className="shrink-0 text-[11px] leading-4 text-ink-500">搜索中…</span>}
          </div>
        </div>

        {/* 结果多时在弹窗内滚动，不把整页顶长 */}
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-6">
          <ul className="flex flex-col">
            {options.length === 0 && (
              <li className="py-6 text-center text-xs leading-5 text-ink-500">
                {searching
                  ? '正在搜索…'
                  : trimmedKeyword
                    ? '没有匹配的账号，换个姓名或 school_id:user_id 试试'
                    : '没有可添加的账号'}
              </li>
            )}

            {options.map((candidate) => {
              const listed = existingSubs.includes(candidate.sub);
              const checked = selectedSubs.has(candidate.sub);
              // 有姓名时副标题给「身份 · 邮箱」；只有身份时别再重复一遍，退化成邮箱或提示
              const secondary =
                candidate.name !== candidate.sub
                  ? [candidate.sub, candidate.email].filter(Boolean).join(' · ')
                  : candidate.email ?? '姓名未同步';
              return (
                <li key={candidate.sub} className="border-b border-line last:border-b-0">
                  <label
                    className={`flex items-center gap-3 py-2 ${
                      listed ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 shrink-0 accent-brand-orange"
                      checked={listed || checked}
                      disabled={listed || saving}
                      onChange={() => toggle(candidate)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-900">
                        {candidateLabel(candidate)}
                      </span>
                      <span className="block truncate text-[11px] leading-4 text-ink-500">
                        {secondary}
                      </span>
                    </span>
                    {listed && (
                      <span className="shrink-0 rounded-[4px] border border-line px-2 py-0.5 text-[11px] text-ink-500">
                        已在名单
                      </span>
                    )}
                  </label>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="border-t border-line px-6 pb-5 pt-3">
          {selected.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-xs leading-5 text-ink-500">已选 {selected.length} 人</span>
              {selected.map((candidate) => (
                <span
                  key={candidate.sub}
                  className="flex items-center gap-1 rounded-full bg-cream-100 py-0.5 pl-2.5 pr-1 text-[11px] leading-4 text-ink-700"
                >
                  {candidateLabel(candidate)}
                  <button
                    type="button"
                    aria-label={`取消选择 ${candidateLabel(candidate)}`}
                    disabled={saving}
                    onClick={() => toggle(candidate)}
                    className="flex h-4 w-4 items-center justify-center rounded-full text-ink-500 transition hover:bg-white hover:text-ink-900 disabled:opacity-50"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          <p className="mb-3 text-[11px] leading-4 text-ink-500">
            结果多时请补充关键字；姓名取自登录账号的开户邮箱。
          </p>

          {error && (
            <p
              role="alert"
              className="mb-3 rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2 text-xs leading-5 text-danger"
            >
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="flex h-9 items-center rounded-control border border-line px-4 text-[13px] text-ink-700 transition hover:bg-cream-100 disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || selected.length === 0}
              className="flex h-9 items-center rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? '保存中…' : `保存${selected.length > 0 ? `（${selected.length}）` : ''}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
