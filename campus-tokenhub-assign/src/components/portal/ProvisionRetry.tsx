'use client';

import { appPath } from '@/lib/paths';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/** 「账号开通中」时的重试按钮：开户是幂等的，多点几次没有副作用。 */
export function ProvisionRetry() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(appPath('/api/portal/provision'), { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? '开通失败，请稍后重试');
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '开通失败，请稍后重试');
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
      {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
    </div>
  );
}
