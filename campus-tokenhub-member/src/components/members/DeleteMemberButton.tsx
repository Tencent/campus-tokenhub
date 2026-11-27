'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { appPath } from '@/lib/paths';

type Props = {
  applicationId: string;
  memberName: string;
  uin: string | null;
};

/**
 * 一键删除成员账号（不可逆）。
 *
 * 为什么要求输入成员名：这是真的会删掉一个腾讯云子账号，连带它的密钥与资源。
 * 普通 `confirm()` 很容易被顺手点掉，输入名字是唯一能强迫人「看一眼删的是谁」的动作。
 */
export function DeleteMemberButton({ applicationId, memberName, uin }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const matched = confirmText.trim() === memberName;

  async function remove(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(appPath(`/api/portal/members/${applicationId}`), {
        method: 'DELETE',
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setError(payload.error ?? '删除失败，请稍后重试');
        return;
      }
      setOpen(false);
      setConfirmText('');
      router.refresh();
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-full border border-[#F5C2BE] px-3.5 py-1.5 text-xs text-danger transition hover:bg-[#FDECEA]"
      >
        删除账号
      </button>
    );
  }

  return (
    <div className="mt-1 w-full rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3.5 py-3">
      <p className="text-xs font-medium text-danger">
        删除成员账号「{memberName}」？
      </p>
      <p className="mt-1 text-xs leading-relaxed text-ink-700">
        这会从腾讯云组织中移除该子账号{uin ? `（UIN ${uin}）` : ''}。
        删除后该账号下的密钥、资源与账单权限立即失效，<strong>无法恢复</strong>。
        门户会保留这条记录用于追溯，本人可以重新申请。
      </p>
      <label className="mt-3 block text-xs text-ink-700">
        输入成员名以确认：
        <input
          value={confirmText}
          onChange={(event) => setConfirmText(event.target.value)}
          placeholder={memberName}
          autoComplete="off"
          spellCheck={false}
          className="mt-1.5 h-9 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-900 outline-none transition focus-visible:border-danger focus-visible:ring-4 focus-visible:ring-danger/15"
        />
      </label>
      {error ? (
        <p role="alert" className="mt-2 break-all text-xs text-danger">
          {error}
        </p>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={!matched || busy}
          onClick={() => void remove()}
          className="rounded-full bg-danger px-4 py-1.5 text-xs font-medium text-white transition hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? '删除中…' : '确认删除'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setConfirmText('');
            setError(null);
          }}
          className="rounded-full border border-line px-4 py-1.5 text-xs text-ink-700 transition hover:border-ink-300 disabled:opacity-40"
        >
          取消
        </button>
      </div>
    </div>
  );
}
