'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { appPath } from '@/lib/paths';
import type { ClaimPeriod, TokenActivityConfig } from '@/lib/activities/types';
import { ActivityPreview } from './ActivityPreview';

type Draft = {
  /** 仅用于 React key；保存后按服务端返回重建 */
  key: string;
  value: TokenActivityConfig;
  /** 已保存过的活动不能改 ID：它是加额幂等键的一部分 */
  locked: boolean;
};

type SaveResponse = {
  activities?: TokenActivityConfig[];
  managed?: boolean;
  degraded?: boolean;
  error?: string;
};

const PERIOD_OPTIONS: { value: ClaimPeriod; label: string }[] = [
  { value: 'once', label: '活动期内一次' },
  { value: 'daily', label: '每天一次' },
  { value: 'weekly', label: '每周一次' },
  { value: 'monthly', label: '每月一次' },
];

const INPUT_CLASS =
  'h-9 w-full rounded-control border border-line bg-white px-3 text-sm text-ink-900 outline-none transition placeholder:text-ink-500 hover:border-ink-300 focus:border-brand-orange focus:ring-4 focus:ring-brand-orange/15 disabled:cursor-not-allowed disabled:bg-cream-100 disabled:text-ink-500';

let draftSeq = 0;

function toDraft(activity: TokenActivityConfig, locked: boolean): Draft {
  return { key: `draft-${draftSeq++}`, value: activity, locked };
}

/** 新活动默认给一个可领取的每日活动，管理员改名字和面额即可 */
function blankDraft(): Draft {
  return toDraft(
    { id: '', title: '', points: 500, period: 'daily', summary: [], enabled: true },
    false
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-medium leading-5 text-ink-700">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-4 text-ink-500">{hint}</span>}
    </label>
  );
}

/**
 * 运营活动配置：增删活动、上下架、改面额与时间窗，整份覆盖写入 `portal_assign.activity_configs`。
 *
 * 学生端「领取算力」卡片直接读这份配置，保存后刷新即生效；
 * ID 上线后锁定，避免改动幂等键导致同一个人能重复领。
 */
export function ActivityConfigEditor({
  initial,
  managed,
  degraded,
}: {
  initial: TokenActivityConfig[];
  managed: boolean;
  degraded: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<Draft[]>(() => initial.map((item) => toDraft(item, true)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const enabledCount = items.filter((item) => item.value.enabled !== false).length;

  function patch(key: string, changes: Partial<TokenActivityConfig>): void {
    setItems((prev) =>
      prev.map((item) => (item.key === key ? { ...item, value: { ...item.value, ...changes } } : item))
    );
  }

  function remove(key: string): void {
    setItems((prev) => prev.filter((item) => item.key !== key));
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(appPath('/api/portal/activities/config'), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activities: items.map((item) => item.value) }),
      });
      const payload = (await response.json().catch(() => ({}))) as SaveResponse;
      if (!response.ok) {
        setError(payload.error ?? '保存失败，请稍后重试');
        return;
      }

      const saved = payload.activities ?? [];
      setItems(saved.map((item) => toDraft(item, true)));
      setNotice('已保存，学生端刷新后即按新配置展示。');
      router.refresh();
    } catch {
      setError('网络异常，请稍后重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {degraded ? (
        <p className="rounded-control bg-cream-100 px-3 py-2 text-xs leading-5 text-ink-500">
          暂时读不到数据库里的活动配置，下面展示的是默认配置；此时保存可能失败。
        </p>
      ) : (
        !managed && (
          <p className="rounded-control bg-cream-100 px-3 py-2 text-xs leading-5 text-ink-500">
            数据库里还没有保存过活动配置，下面展示的是默认配置；保存一次后就以数据库里的配置为准。
          </p>
        )
      )}

      <section className="flex flex-col gap-4 rounded-card border border-line bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold leading-6 text-ink-900">活动列表</h2>
            <p className="mt-0.5 text-xs leading-5 text-ink-500">
              共 {items.length} 个活动，{enabledCount} 个上架中（下架的活动既不展示也不再发放）。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => setItems((prev) => [...prev, blankDraft()])}
              className="h-9 rounded-control border border-line px-3 text-[13px] text-ink-700 transition hover:bg-cream-100 disabled:opacity-40"
            >
              新增活动
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save()}
              aria-busy={busy}
              className="h-9 rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:opacity-60"
            >
              {busy ? '保存中…' : '保存配置'}
            </button>
          </div>
        </div>

        {notice && (
          <p role="status" className="text-xs leading-5 text-success">
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-3 py-2 text-xs leading-5 text-danger"
          >
            {error}
          </p>
        )}

        {items.length === 0 && (
          <p className="rounded-control border border-dashed border-line px-3 py-6 text-center text-xs leading-5 text-ink-500">
            还没有活动。点「新增活动」配置第一个，保存后学生端会出现领取卡片。
          </p>
        )}

        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const { value } = item;
            const off = value.enabled === false;

            return (
              <article key={item.key} className="flex flex-col gap-3 rounded-control border border-line p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="min-w-0 truncate text-sm font-semibold leading-5 text-ink-900">
                    {value.title || '未命名活动'}
                  </h3>
                  <span
                    className={`rounded-[4px] px-1.5 text-[11px] leading-5 ${
                      off ? 'bg-cream-100 text-ink-500' : 'bg-brand-orange-soft text-[#2557D6]'
                    }`}
                  >
                    {off ? '已下架' : '上架中'}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => patch(item.key, { enabled: off })}
                      className="rounded-control border border-line px-3 py-1.5 text-xs text-ink-700 transition hover:bg-cream-100 disabled:opacity-40"
                    >
                      {off ? '上架' : '下架'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(item.key)}
                      className="rounded-control border border-line px-3 py-1.5 text-xs text-ink-700 transition hover:bg-cream-100 disabled:opacity-40"
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <Field label="活动名称">
                    <input
                      className={INPUT_CLASS}
                      value={value.title}
                      maxLength={40}
                      disabled={busy}
                      placeholder="如：每日加油包"
                      onChange={(event) => patch(item.key, { title: event.target.value })}
                    />
                  </Field>

                  <Field
                    label="活动 ID"
                    hint={item.locked ? '活动 ID 是加额幂等键的一部分，上线后不可修改' : '小写字母 / 数字 / 短横线，保存后不可再改'}
                  >
                    <input
                      className={`${INPUT_CLASS} font-mono`}
                      value={value.id}
                      maxLength={48}
                      disabled={busy || item.locked}
                      placeholder="如：daily-recharge"
                      onChange={(event) => patch(item.key, { id: event.target.value })}
                    />
                  </Field>

                  <Field label="每次发放算力值">
                    <input
                      type="number"
                      min={1}
                      max={10_000_000}
                      step={1}
                      className={INPUT_CLASS}
                      value={value.points}
                      disabled={busy}
                      onChange={(event) => {
                        const next = Number(event.target.value);
                        patch(item.key, { points: Number.isFinite(next) ? next : 0 });
                      }}
                    />
                  </Field>

                  <Field label="可领取频次">
                    <select
                      className={INPUT_CLASS}
                      value={value.period}
                      disabled={busy}
                      onChange={(event) =>
                        patch(item.key, { period: event.target.value as ClaimPeriod })
                      }
                    >
                      {PERIOD_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </Field>

                  <Field label="开始日期（含当天）" hint="留空表示不限">
                    <input
                      type="date"
                      className={INPUT_CLASS}
                      value={value.startsOn ?? ''}
                      disabled={busy}
                      onChange={(event) => patch(item.key, { startsOn: event.target.value })}
                    />
                  </Field>

                  <Field label="结束日期（含当天）" hint="留空表示不限">
                    <input
                      type="date"
                      className={INPUT_CLASS}
                      value={value.endsOn ?? ''}
                      disabled={busy}
                      onChange={(event) => patch(item.key, { endsOn: event.target.value })}
                    />
                  </Field>

                  <Field label="角标（可选）" hint="卡片右上角，如「限时抢领」">
                    <input
                      className={INPUT_CLASS}
                      value={value.badge ?? ''}
                      maxLength={12}
                      disabled={busy}
                      onChange={(event) => patch(item.key, { badge: event.target.value })}
                    />
                  </Field>

                  <Field label="按钮文案（可选）" hint="默认「立即领取」">
                    <input
                      className={INPUT_CLASS}
                      value={value.ctaLabel ?? ''}
                      maxLength={12}
                      disabled={busy}
                      onChange={(event) => patch(item.key, { ctaLabel: event.target.value })}
                    />
                  </Field>
                </div>

                <Field label="活动说明（一行一条）" hint="最多 6 行，每行 60 字以内">
                  <textarea
                    className="w-full rounded-control border border-line bg-white px-3 py-2 text-sm leading-5 text-ink-900 outline-none transition placeholder:text-ink-500 hover:border-ink-300 focus:border-brand-orange focus:ring-4 focus:ring-brand-orange/15 disabled:opacity-60"
                    rows={3}
                    value={value.summary.join('\n')}
                    disabled={busy}
                    placeholder={'每天可申领一次 · 全校师生\n支持全场已上架大模型'}
                    onChange={(event) => patch(item.key, { summary: event.target.value.split('\n') })}
                  />
                </Field>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="activity-preview-title" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 id="activity-preview-title" className="text-base font-semibold leading-6 text-ink-900">
            学生端预览
          </h2>
          <p className="text-xs leading-5 text-ink-500">
            按当前表单实时渲染（含未保存的修改）；只展示卡片样式，不含「已领取 / 未开始」等个人状态
          </p>
        </div>

        <ActivityPreview activities={items.map((item) => item.value)} />
      </section>
    </div>
  );
}
