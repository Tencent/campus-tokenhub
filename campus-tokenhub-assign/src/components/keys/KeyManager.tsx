'use client';

import { appPath } from '@/lib/paths';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CopyButton } from '@/components/ui/CopyButton';
import type { GatewayKey } from '@/lib/gateway/types';
import { formatDateTime } from '@/lib/gateway/format';
import { invalidateActiveKey, loadActiveKey } from '@/lib/portal/key-cache';
import { refreshAfterMutation } from '@/lib/portal/refresh-after-mutation';

function IconKey() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <ellipse cx="5.4" cy="10.4" rx="2.7" ry="2.7" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.6 8.4L13.4 2.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M11.2 4.8l1.7 1.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 「我的 API Key」卡：密钥不再是独立页面，创建 / 复制 / 吊销 / 删除都在算力账户页完成。
 * 首屏数据由服务端并行取好，交互后自行刷新列表并 router.refresh() 更新服务端渲染部分。
 */
export function KeyManager({
  initialKeys,
  ready,
  loadFailed,
  accountStatus,
}: {
  initialKeys: GatewayKey[];
  ready: boolean;
  loadFailed: boolean;
  accountStatus: string | null;
}) {
  const router = useRouter();
  const [keys, setKeys] = useState<GatewayKey[]>(initialKeys);
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failed, setFailed] = useState(loadFailed);
  /** 创建弹窗；吊销/删除走行内二次确认，不弹窗 */
  const [creating, setCreating] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const activeKey = keys.find((key) => key.status === 'active') ?? null;
  const historyKeys = keys.filter((key) => key.status !== 'active');
  /** 仅当能读到用户状态且明确不是 active 时才拦截创建；读不到状态时按未知放行。 */
  const suspended = Boolean(accountStatus) && accountStatus !== 'active';

  // 成功提示自动消失，避免一直占着卡片
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 弹窗：Esc 关闭 + 打开时把焦点送进去
  useEffect(() => {
    if (!creating) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setCreating(false);
    };

    document.addEventListener('keydown', onKeyDown);
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [creating]);

  async function refresh(): Promise<GatewayKey[]> {
    const response = await fetch(appPath('/api/portal/keys'), { cache: 'no-store' });
    const body = (await response.json().catch(() => ({}))) as { keys?: GatewayKey[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? '读取密钥失败');
    const next = body.keys ?? [];
    setKeys(next);
    return next;
  }

  async function retryLoad(): Promise<void> {
    setRetrying(true);
    setError(null);
    setNotice(null);
    try {
      const next = await refresh();
      setFailed(false);
      setNotice(next.length ? '密钥列表已更新。' : '密钥列表已更新：当前还没有密钥。');
    } catch (cause) {
      setFailed(true);
      setError(cause instanceof Error ? cause.message : '读取密钥失败');
    } finally {
      setRetrying(false);
    }
  }

  async function create(): Promise<void> {
    if (suspended) {
      setError('当前账号状态不是「使用中」，无法创建密钥。请联系管理员恢复账号。');
      setCreating(false);
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(appPath('/api/portal/keys'), { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? '创建失败，请稍后重试');
      const result = await refreshAfterMutation(() => {
        invalidateActiveKey();
        router.refresh();
      }, refresh);
      setFailed(!result.refreshed);
      setNotice(result.refreshed ? '密钥已创建，可随时回来复制。' : '密钥已创建，但列表刷新失败，请重新读取。');
      if (!result.refreshed) setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
    } finally {
      setBusy(false);
      setCreating(false);
    }
  }

  async function revoke(key: GatewayKey): Promise<void> {
    setConfirmingId(null);
    setRevokingId(key.id);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(appPath(`/api/portal/keys/${encodeURIComponent(key.id)}`), { method: 'DELETE' });
      const body = (await response.json().catch(() => ({}))) as { error?: string; already_gone?: boolean };
      if (!response.ok) throw new Error(body.error ?? '吊销失败');
      const result = await refreshAfterMutation(() => {
        invalidateActiveKey();
        router.refresh();
      }, refresh);
      setFailed(!result.refreshed);
      setNotice(result.refreshed
        ? (body.already_gone ? '该密钥已不存在，列表已刷新。' : '密钥已吊销。')
        : '密钥已失效，但列表刷新失败，请重新读取。');
      if (!result.refreshed) setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '吊销失败');
    } finally {
      setRevokingId(null);
      setBusy(false);
    }
  }

  return (
    <section id="my-api-key" className="flex flex-col gap-3.5 rounded-card border border-line bg-white p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            aria-hidden
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-orange-soft text-brand-link"
          >
            <IconKey />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold leading-6 text-ink-900">我的 API Key</h2>
              {activeKey && (
                <span className="rounded-[4px] bg-[#E8F5EE] px-1.5 py-0.5 text-[11px] font-medium text-[#17914F]">
                  使用中
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs leading-5 text-ink-500">
              {activeKey ? '一人一把，仅限本人使用。' : '接入模型服务需要一把个人密钥。'}
            </p>
          </div>
        </div>

        {activeKey && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <CopyButton
              resolveValue={async () => {
                // 明文不下发到页面，点复制时才按需取一次（/api/portal/key 带 no-store）
                const result = await loadActiveKey();
                if (!result.ok) throw new Error(result.error);
                return result.key;
              }}
              label="复制"
              className="flex h-8 items-center rounded-control border border-line bg-white px-3 text-xs font-medium text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
            />
            <Link
              href={`/playground?key=${encodeURIComponent(activeKey.id)}`}
              className="flex h-8 items-center rounded-control border border-line bg-white px-3 text-xs font-medium text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
            >
              调试
            </Link>
            {confirmingId === activeKey.id ? (
              <>
                <button
                  type="button"
                  autoFocus
                  onClick={() => revoke(activeKey)}
                  disabled={busy}
                  className="flex h-8 items-center rounded-control border border-rose-300 bg-rose-50 px-3 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
                >
                  {revokingId === activeKey.id ? '吊销中…' : '确认吊销'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingId(null)}
                  disabled={busy}
                  className="flex h-8 items-center rounded-control border border-line px-3 text-xs text-ink-600 transition hover:bg-cream-100 disabled:opacity-50"
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingId(activeKey.id)}
                disabled={busy}
                className="flex h-8 items-center rounded-control border border-rose-200 px-3 text-xs font-medium text-rose-600 transition hover:bg-rose-50 disabled:opacity-50"
              >
                吊销
              </button>
            )}
          </div>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-control border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-control border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-700">
          {notice}
        </div>
      )}
      {failed && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-rose-200 bg-rose-50 px-3 py-2">
          <p className="text-xs leading-5 text-rose-700">暂时无法读取密钥列表，下面的内容可能不是最新的。</p>
          <button
            type="button"
            onClick={retryLoad}
            disabled={retrying || busy}
            className="shrink-0 rounded-control border border-rose-300 bg-white px-2.5 py-1 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {retrying ? '读取中…' : '重新读取'}
          </button>
        </div>
      )}

      {!ready ? (
        <p className="text-[13px] leading-5 text-ink-700">
          账号还在开通中，开通后才能创建密钥。请先点上面的「重试开通」。
        </p>
      ) : activeKey ? (
        <>
          <div className="flex items-center gap-2 rounded-control bg-cream-100 px-3 py-2.5">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium leading-5 text-ink-900">
              {activeKey.key || '—'}
            </code>
          </div>
          <p className="text-[11px] leading-4 text-ink-500">
            创建于 {formatDateTime(activeKey.created_at)} · 最近使用 {formatDateTime(activeKey.last_used_at)}
            {confirmingId === activeKey.id ? ' · 吊销后立即失效，需要重新创建' : ''}
          </p>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] leading-5 text-ink-700">
            {suspended
              ? `当前账号状态为「${accountStatus}」，暂时不能创建密钥；请联系管理员恢复账号后再试。`
              : '创建后可直接用于 WorkBuddy、Cherry Studio 或你自己的代码，吊销后可以立即重建。'}
          </p>
          <button
            type="button"
            onClick={() => setCreating(true)}
            disabled={busy || suspended}
            className="flex h-9 shrink-0 items-center rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            创建 API Key
          </button>
        </div>
      )}

      {historyKeys.length > 0 && (
        <details className="rounded-control border border-line bg-cream/40 px-3 py-2">
          <summary className="cursor-pointer text-xs font-medium leading-5 text-ink-600">
            历史密钥（{historyKeys.length}）
          </summary>
          <ul className="mt-1 divide-y divide-line text-xs">
            {historyKeys.map((key) => (
              <li key={key.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="truncate text-ink-700">{key.name || key.id}</div>
                  <div className="text-[11px] text-ink-500">
                    {key.status} · {formatDateTime(key.created_at)}
                  </div>
                </div>
                {confirmingId === key.id ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      autoFocus
                      onClick={() => revoke(key)}
                      disabled={busy}
                      className="rounded-control border border-rose-300 bg-rose-50 px-2.5 py-1 font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
                    >
                      {revokingId === key.id ? '删除中…' : '确认删除'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingId(null)}
                      disabled={busy}
                      className="rounded-control border border-line px-2.5 py-1 text-ink-600 transition hover:bg-cream-100 disabled:opacity-50"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmingId(key.id)}
                    disabled={busy}
                    className="shrink-0 rounded-control border border-line px-2.5 py-1 text-ink-600 transition hover:border-rose-200 hover:text-rose-600 disabled:opacity-50"
                  >
                    删除
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-key-title"
            className="w-full max-w-sm rounded-xl bg-white p-6 shadow-[0_8px_24px_-2px_rgba(0,0,0,0.1)]"
          >
            <h3 id="create-key-title" className="text-[15px] font-semibold leading-6 text-ink-900">
              创建 API Key
            </h3>
            <p className="mt-2 text-[13px] leading-5 text-ink-600">
              每人一把密钥，创建后立即可用。密钥会一直保留在门户里，随时可以回来复制，不用一次抄完。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                disabled={busy}
                className="flex h-9 items-center rounded-control border border-line px-4 text-[13px] text-ink-700 transition hover:bg-cream-100 disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={create}
                disabled={busy}
                className="flex h-9 items-center rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busy ? '正在创建…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
