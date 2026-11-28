'use client';

import { appPath } from '@/lib/paths';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type FailureDetail = {
  /** 面向用户的泛化文案 */
  message: string;
  /** 网关/上游的真实原因：只有管理员请求才会被服务端下发 */
  reason: string | null;
  /** 与服务端日志对得上的排障 id */
  requestId: string | null;
};

/** 「账号开通中」时的重试按钮：开户是幂等的，多点几次没有副作用。 */
export function ProvisionRetry() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<FailureDetail | null>(null);

  async function retry(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(appPath('/api/portal/provision'), { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        request_id?: string;
      };
      if (!response.ok) {
        setFailure({
          message: body.error ?? '开通失败，请稍后重试',
          reason: body.reason?.trim() || null,
          requestId: body.request_id ?? response.headers.get('x-request-id'),
        });
        return;
      }
      router.refresh();
    } catch {
      // 网络中断 / 网关超时：这是「连不上」，不是「服务说失败」，文案要分开
      setFailure({ message: '开通请求没有完成，请检查网络后重试', reason: null, requestId: null });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        onClick={retry}
        disabled={busy}
        className="rounded-control bg-brand-orange px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? '正在开通…' : '重试开通'}
      </button>
      {failure && (
        <div className="mt-2 space-y-1">
          <p className="text-sm text-rose-600">{failure.message}</p>
          {/* 管理员可见：把「为什么失败」和「拿哪条 id 去捞日志」直接摊在页面上，
              否则只能看到一句泛化文案，排障全靠猜。 */}
          {failure.reason && (
            <p className="text-xs leading-4 text-ink-500">原因：{failure.reason}</p>
          )}
          {failure.requestId && (
            <p className="text-xs leading-4 text-ink-500">
              排查编号：<span className="font-mono">{failure.requestId}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
