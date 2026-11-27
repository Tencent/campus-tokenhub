'use client';

import { appPath } from '@/lib/paths';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Props = {
  applicationId: string;
  canRetry: boolean;
  isPending: boolean;
  /** 缺部门的单不能通过：通过即建号，没有部门会落到 root */
  canApprove?: boolean;
};

/** 审核动作：通过 / 驳回（必填理由）/ 重试开通。提交中禁用按钮，避免重复点击。 */
export function ReviewActions({ applicationId, canRetry, isPending, canApprove = true }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function act(body: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setApproving(body.action === 'approve');
    setError(null);
    try {
      const response = await fetch(appPath(`/api/portal/members/${applicationId}/review`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? '操作失败，请稍后重试');
        return;
      }
      setRejecting(false);
      setNote('');
      router.refresh();
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setBusy(false);
      setApproving(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {isPending && (
          <>
            <button
              type="button"
              disabled={busy || !canApprove}
              title={canApprove ? undefined : '申请人尚未补填部门'}
              onClick={() => void act({ action: 'approve' })}
              className="flex h-9 items-center rounded-control bg-brand-orange px-3 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy ? (approving ? '处理中（建部门 + 开通，最长约 1 分钟）…' : '处理中…') : '通过并开通'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setRejecting((value) => !value)}
              className="rounded-control border border-line px-3 py-1.5 text-xs text-ink-700 transition hover:bg-cream-100 disabled:opacity-60"
            >
              {rejecting ? '取消驳回' : '驳回'}
            </button>
          </>
        )}

        {canRetry && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void act({ action: 'retry' })}
            className="rounded-control border border-line px-3 py-1.5 text-xs text-ink-700 transition hover:bg-cream-100 disabled:opacity-60"
          >
            {busy ? '处理中…' : '重试开通'}
          </button>
        )}
      </div>

      {isPending && !canApprove && (
        <p className="text-xs leading-5 text-ink-500">
          申请人尚未补填部门，暂时无法通过；可驳回并请其补填后再提交。
        </p>
      )}

      {rejecting && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="w-full rounded-control border border-line bg-white px-3 py-1.5 text-xs text-ink-900 outline-none transition hover:border-ink-300 focus:border-brand-orange focus:ring-4 focus:ring-brand-orange/15"
            placeholder="驳回理由（必填，老师会看到）"
            value={note}
            maxLength={200}
            onChange={(event) => setNote(event.target.value)}
          />
          <button
            type="button"
            disabled={busy || note.trim().length === 0}
            onClick={() => void act({ action: 'reject', note })}
            className="shrink-0 rounded-control border border-[#F5C2BE] px-3 py-1.5 text-xs text-danger transition hover:bg-[#FDECEA] disabled:opacity-50"
          >
            确认驳回
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2 text-xs leading-5 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
