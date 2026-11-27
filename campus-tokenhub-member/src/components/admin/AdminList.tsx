'use client';

import { useState } from 'react';
import { appPath } from '@/lib/paths';
import { mergeAdminCandidates } from '@/lib/admin/presentation';
import type { AdminCandidate } from '@/lib/admin/types';
import { AdminPickerDialog } from './AdminPickerDialog';

type Props = {
  /** 当前生效的名单（网关优先，网关未接管时为 env 兜底值） */
  subs: string[];
  /** 当前登录身份，用于禁止自删 */
  currentSub: string;
  /** 网关里是否已有名单（false 表示还在用 env 兜底） */
  managed: boolean;
  /** 网关读取失败，名单来自 env 兜底 */
  degraded: boolean;
  /** 初始候选：名单、自己与网关最近一页；弹窗空关键字时直接用它 */
  candidates: AdminCandidate[];
};

type ApiResponse = { subs?: string[]; error?: string };

/**
 * 全局管理员名单维护：列表逐条移除，新增走弹窗（搜索 + 多选 + 保存才提交）。
 *
 * 名单里的人是单一角色——全局管理员：设置、运营活动、网关后台、成员审核、名单维护通吃，
 * 因此列表里不再提供角色下拉。
 * 移除是单条、可逆操作（重新加回来即可），保持即时提交；新增常见于一次挑多人，
 * 因此集中到弹窗里，避免每点一个人就打一次网关。
 */
export function AdminList({ subs: initialSubs, currentSub, managed, degraded, candidates }: Props) {
  const [subs, setSubs] = useState(initialSubs);
  const [pool, setPool] = useState(candidates);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 待二次确认的身份：移除管理员影响权限，避免单击即删 */
  const [confirmSub, setConfirmSub] = useState<string | null>(null);

  const bySub = new Map(pool.map((item) => [item.sub, item]));

  async function remove(sub: string): Promise<void> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(appPath('/api/portal/admins'), {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sub }),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiResponse;
      if (!response.ok) {
        setError(payload.error ?? '操作失败，请稍后重试');
        return;
      }
      setSubs(payload.subs ?? subs);
      setNotice('已从管理员名单移除');
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setBusy(false);
      setConfirmSub(null);
    }
  }

  function handleSaved(nextSubs: string[], added: AdminCandidate[]): void {
    setSubs(nextSubs);
    // 把刚选中的候选并进本地池：列表里立刻能显示姓名，不必等页面刷新
    setPool((previous) =>
      mergeAdminCandidates(
        previous,
        added.map((item) => ({ ...item, listed: true }))
      )
    );
    setPickerOpen(false);
    setError(null);
    setNotice(added.length === 1 ? '已设为全局管理员' : `已添加 ${added.length} 位全局管理员`);
  }

  return (
    <div className="flex flex-col gap-3">
      {!managed && (
        <p className="rounded-control bg-cream-100 px-3 py-2 text-xs leading-5 text-ink-500">
          {degraded
            ? '暂时读不到数据库里的管理员名单，请稍后重试；此时保存会失败。'
            : '数据库里还没有管理员名单，当前回退到初始化负责人（同样按全局管理员处理）；在这里添加后会以这份名单为准。'}
        </p>
      )}

      <section className="rounded-card border border-line bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold leading-6 text-ink-900">全局管理员</h2>
            <p className="mt-1 text-sm leading-5 text-ink-500">
              名单里的人都可以使用系统设置、运营活动、网关管理后台与成员审核，也能维护这份名单。
              名单存在门户数据库，改完立即生效。
            </p>
          </div>
          <button
            type="button"
            disabled={degraded}
            onClick={() => {
              setNotice(null);
              setError(null);
              setConfirmSub(null);
              setPickerOpen(true);
            }}
            title={degraded ? '暂时读不到管理员名单，恢复后再添加' : undefined}
            className="flex h-9 shrink-0 items-center rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            添加管理员
          </button>
        </div>

        <ul className="mt-4 flex flex-col gap-2">
          {subs.length === 0 && (
            <li className="text-sm text-ink-500">
              {degraded
                ? '暂时读不到管理员名单，恢复后刷新即可。'
                : '名单为空：当前回退到初始化负责人（onboarding owner）。'}
            </li>
          )}
          {subs.map((sub) => {
            const isSelf = sub === currentSub;
            const candidate = bySub.get(sub);
            const name = candidate?.name;
            return (
              <li
                key={sub}
                className="flex flex-wrap items-center gap-3 rounded-control border border-line px-3 py-2"
              >
                {name && name !== sub ? (
                  <>
                    <span className="text-sm text-ink-900">{name}</span>
                    <span className="font-mono text-xs text-ink-500">{sub}</span>
                  </>
                ) : (
                  <>
                    <span className="font-mono text-sm text-ink-900">{sub}</span>
                    <span className="text-[11px] text-ink-500">姓名未同步</span>
                  </>
                )}
                <span className="rounded-[4px] border border-line px-2 py-0.5 text-[11px] text-ink-500">
                  全局管理员
                </span>
                {isSelf && (
                  <span className="rounded-[4px] border border-line px-2 py-0.5 text-[11px] text-ink-500">
                    当前登录
                  </span>
                )}
                {confirmSub === sub ? (
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <span className="text-[11px] leading-4 text-ink-500">确认移除？</span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(sub)}
                      className="rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-1.5 text-xs text-danger transition hover:bg-[#F9DCD8] disabled:opacity-50"
                    >
                      {busy ? '移除中…' : '确认移除'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setConfirmSub(null)}
                      className="rounded-control border border-line px-3 py-1.5 text-xs text-ink-700 transition hover:bg-cream-100 disabled:opacity-50"
                    >
                      取消
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy || isSelf || degraded}
                    onClick={() => {
                      setError(null);
                      setNotice(null);
                      setConfirmSub(sub);
                    }}
                    className="ml-auto rounded-control border border-line px-3 py-1.5 text-xs text-ink-700 transition hover:bg-cream-100 disabled:opacity-40"
                  >
                    移除
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-xs leading-5 text-ink-500">
          候选项来自成员账号申请记录，结果多时补充关键字即可。姓名取自申请单，
          历史账号本人重新登录一次后会自动补全。
        </p>

        {notice && (
          <p role="status" className="mt-3 text-xs leading-5 text-success">
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2 text-xs leading-5 text-danger"
          >
            {error}
          </p>
        )}
      </section>

      {pickerOpen && (
        <AdminPickerDialog
          existingSubs={subs}
          initialCandidates={candidates}
          onClose={() => setPickerOpen(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
