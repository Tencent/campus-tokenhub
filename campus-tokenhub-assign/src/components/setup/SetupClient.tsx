'use client';

import { appPath } from '@/lib/paths';
import { formatTokens } from '@/lib/portal/usage-format';
import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { ApplyResult, OnboardingPlan, ProbeResult } from '@/lib/onboarding/types';
import {
  MODEL_CATALOG_UPDATED_AT,
  MODEL_CATALOG_VERSION,
  catalogPriceText,
  catalogUnsupportedReason,
  getCatalogEntry,
} from '@/lib/onboarding/model-catalog';
import {
  MODEL_CATEGORY_META,
  MODEL_CATEGORY_ORDER,
  inferCategoryFromId,
  type ModelCategoryKey,
} from '@/lib/onboarding/model-category';
import { formatPointsUnitPrice } from '@/lib/portal/points';
import { isSharedModel } from '@/lib/onboarding/shared-routing';

export type SetupModelOption = {
  id: string;
  displayName: string;
  vendor: string;
  contextWindow: number | null;
  maxTokens: number | null;
  inputPrice: string;
  outputPrice: string;
  imagePrice: string | null;
  /** 当前实例已启用（仅作参考，不再决定默认勾选） */
  recommended: boolean;
  /** 默认勾选的主流模型 */
  featured: boolean;
  needsPostpaid: boolean;
  routeStatus: 'active' | 'disabled';
  nonChat: boolean;
  category: ModelCategoryKey;
  /** 同款模型跨厂商共用一个路由池（按权重分流） */
  shared: boolean;
};

type Stage = 'key' | 'models' | 'done';

/** 列表行：清单模型 + 上游返回但未收录的模型（未收录的模型从静态目录读参数与价格）。 */
type DisplayModel = SetupModelOption & {
  source: 'preset' | 'upstream';
  /** 网关导入不了的原因；为空表示可勾选 */
  unsupported: string | null;
  /** 静态目录里的一行价格说明（仅未收录模型有） */
  priceText: string | null;
};

/** 排序：推荐 → 清单里启用的 → 清单里停用的 → 上游未收录。 */
function rankOf(model: DisplayModel): number {
  if (model.source === 'upstream') return 3;
  if (model.featured) return 0;
  if (model.routeStatus === 'active') return 1;
  return 2;
}

type Props = {
  /** tencent / aliyun / volcano，探测与写入都要带上 */
  providerKey: string;
  /** Key 输入框标签，如「TokenHub API Key」/「百炼 API Key」 */
  keyLabel: string;
  /** 「还没有 Key？…」链接文案 */
  keyLinkLabel: string;
  /** 清单外模型是否可按静态目录补价；非腾讯云只接热门模型 */
  catalogScope: 'tencent' | 'none';
  /** 参数与价格的来源说明 */
  priceSourceLabel: string;
  presetVersion: string;
  providerName: string;
  /** 供应商的 API Key 管理页；学校用自己的云账号登录后创建 */
  apiKeyUrl: string;
  providerBase: string;
  models: SetupModelOption[];
  defaultSelected: string[];
  initialState: {
    /** 网关已完成过初始化：本次是重跑（只补缺，不删除未勾选的模型） */
    completed: boolean;
    providerExists: boolean;
    /** 网关里已保存的 Key 掩码指纹；有值时允许直接复用 */
    existingKeyHint: string | null;
    modelCount: number;
    routeCount: number;
    gatewaySeeded: boolean;
  };
};

/** 上下文/输出上限：与模型集市、接入指南共用同一套 K/M 口径 */
function formatContext(value: number | null): string {
  return value ? formatTokens(value) : '—';
}

function ActionBadge({ action }: { action: 'create' | 'update' | 'skip' }) {
  const map = {
    create: { label: '新建', className: 'bg-emerald-50 text-emerald-700' },
    update: { label: '更新', className: 'bg-brand-yellow-soft text-amber-700' },
    skip: { label: '跳过', className: 'bg-cream-100 text-ink-500' },
  } as const;
  const item = map[action];
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${item.className}`}>{item.label}</span>;
}

export function SetupClient({
  providerKey,
  keyLabel,
  keyLinkLabel,
  catalogScope,
  priceSourceLabel,
  presetVersion,
  providerName,
  apiKeyUrl,
  providerBase,
  models,
  defaultSelected,
  initialState,
}: Props) {
  const [stage, setStage] = useState<Stage>('key');
  const [keyMode, setKeyMode] = useState<'saved' | 'new'>(initialState.existingKeyHint ? 'saved' : 'new');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  /**
   * 探测轮次：Key 变化 / 切换 Key 来源时自增。
   * 只清 `probe` 拦不住在途请求——A 的响应回来仍会 setStage('models')，
   * 而真正提交的是 B 的 Key，等于用旧结论放行新 Key。
   */
  const probeSeqRef = useRef(0);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(defaultSelected));
  const [forceOverwrite, setForceOverwrite] = useState(false);
  const [plan, setPlan] = useState<OnboardingPlan | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState<'plan' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const existingKeyHint = initialState.existingKeyHint;
  /** 已完成过初始化：本次是重跑，措辞与按钮文案都要区分 */
  const wasCompleted = initialState.completed;
  /** 复用网关里已保存的 Key；此时提交不带 apiKey，网关侧 provider 走跳过 */
  const usingSavedKey = keyMode === 'saved' && Boolean(existingKeyHint);

  /** 清单模型 + 上游返回但清单未收录的模型，合成同一个列表。 */
  const displayModels = useMemo<DisplayModel[]>(() => {
    const presetRows: DisplayModel[] = models.map((model) => ({
      ...model,
      source: 'preset',
      unsupported: null,
      priceText: null,
    }));
    if (!probe?.models || catalogScope !== 'tencent') return presetRows;

    const known = new Set(models.map((model) => model.id));
    const extraRows: DisplayModel[] = [...new Set(probe.models)]
      .filter((id) => !known.has(id))
      .map((id) => {
        const entry = getCatalogEntry(id);
        const unsupported = entry
          ? catalogUnsupportedReason(entry)
          : `不在腾讯云模型目录（${MODEL_CATALOG_VERSION}）中，暂不支持导入`;
        const tokenPrice = entry?.pricing.mode === 'token' ? entry.pricing : null;
        const imagePrice = entry?.pricing.mode === 'per_image' ? entry.pricing.price : null;
        return {
          id,
          displayName: entry?.name ?? id,
          vendor: entry?.vendor ?? '',
          contextWindow: entry?.contextWindow ?? null,
          maxTokens: entry?.maxOutput ?? null,
          inputPrice: tokenPrice ? formatPointsUnitPrice(tokenPrice.input, 'M') : '—',
          outputPrice: tokenPrice ? formatPointsUnitPrice(tokenPrice.output, 'M') : '—',
          imagePrice: imagePrice === null ? null : formatPointsUnitPrice(imagePrice, '张'),
          recommended: false,
          featured: false,
          needsPostpaid: entry?.category === 'image',
          routeStatus: 'active' as const,
          nonChat: false,
          category: entry?.category ?? inferCategoryFromId(id),
          shared: isSharedModel(id),
          source: 'upstream' as const,
          unsupported,
          priceText: entry && entry.pricing.mode !== 'none' ? catalogPriceText(entry) : null,
        };
      });
    return [...presetRows, ...extraRows];
  }, [catalogScope, models, probe]);

  /** 按模型类型分组，只保留有模型的类别；顺序即向导步骤顺序。 */
  const groups = useMemo(
    () =>
      MODEL_CATEGORY_ORDER.map((key) => ({
        key,
        meta: MODEL_CATEGORY_META[key],
        models: displayModels
          .filter((model) => model.category === key)
          .sort((a, b) => rankOf(a) - rankOf(b) || a.displayName.localeCompare(b.displayName)),
      })).filter((group) => group.models.length > 0),
    [displayModels]
  );

  const [activeCategory, setActiveCategory] = useState<ModelCategoryKey | null>(null);
  const activeGroup = groups.find((group) => group.key === activeCategory) ?? groups[0] ?? null;
  const activeIndex = activeGroup ? groups.findIndex((group) => group.key === activeGroup.key) : -1;

  const selectedIds = useMemo(
    () => displayModels.filter((model) => selected.has(model.id) && !model.unsupported).map((model) => model.id),
    [displayModels, selected]
  );
  const upstreamModels = useMemo(() => (probe?.models ? new Set(probe.models) : null), [probe]);
  const upstreamCount = displayModels.length - models.length;

  /** 只接热门模型的供应商：上游多出来的模型不展示，只报数量 */
  const hiddenUpstreamCount = useMemo(() => {
    if (!probe?.models || catalogScope === 'tencent') return 0;
    const known = new Set(models.map((model) => model.id));
    return [...new Set(probe.models)].filter((id) => !known.has(id)).length;
  }, [catalogScope, models, probe]);

  const selectedExtras = useMemo(
    () => displayModels.filter((model) => model.source === 'upstream' && selected.has(model.id) && !model.unsupported),
    [displayModels, selected]
  );
  const canSubmit = selectedIds.length > 0;

  function selectGroup(picked: boolean): void {
    if (!activeGroup) return;
    const ids = activeGroup.models.filter((model) => !model.unsupported).map((model) => model.id);
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (picked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function goToGroup(offset: number): void {
    const target = groups[activeIndex + offset];
    if (target) setActiveCategory(target.key);
  }

  function toggle(id: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function switchKeyMode(mode: 'saved' | 'new'): void {
    setKeyMode(mode);
    // 换 Key 来源后旧探测结论（含在途请求）不再适用，退回第一步重新验证
    probeSeqRef.current += 1;
    setProbing(false);
    setProbe(null);
    setError(null);
    setStage('key');
  }

  async function runProbe(): Promise<void> {
    const seq = ++probeSeqRef.current;
    setProbing(true);
    setError(null);
    setProbe(null);
    try {
      const response = await fetch(appPath('/api/setup/probe'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          usingSavedKey ? { provider: providerKey, useExisting: true } : { provider: providerKey, apiKey }
        ),
      });
      const body = (await response.json().catch(() => ({}))) as { result?: ProbeResult; error?: string };
      // 期间改过 Key / 换过 Key 来源：这轮结果已过期，直接丢弃
      if (seq !== probeSeqRef.current) return;
      if (!response.ok || !body.result) throw new Error(body.error ?? '检测失败，请稍后重试');
      setProbe(body.result);
      if (body.result.ok) {
        setStage('models');
      } else {
        setError(body.result.error ?? 'Key 检测未通过');
      }
    } catch (cause) {
      if (seq !== probeSeqRef.current) return;
      setError(cause instanceof Error ? cause.message : '检测失败，请稍后重试');
    } finally {
      if (seq === probeSeqRef.current) setProbing(false);
    }
  }

  async function submit(dryRun: boolean): Promise<void> {
    setBusy(dryRun ? 'plan' : 'apply');
    setError(null);
    if (dryRun) setResult(null);
    try {
      // 只需传 id：服务端从静态目录取官方价，页面上不再填写价格
      const extraModels = selectedExtras.map((model) => ({ id: model.id }));
      const response = await fetch(appPath('/api/setup/apply'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: providerKey,
          // 复用已保存的 Key 时不带 apiKey，服务端据此跳过 provider 的密钥写入
          apiKey: usingSavedKey ? null : apiKey,
          modelIds: selectedIds,
          extraModels,
          forceOverwrite,
          dryRun,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        plan?: OnboardingPlan;
        result?: ApplyResult | null;
        error?: string;
      };
      if (!response.ok || !body.plan) throw new Error(body.error ?? '执行失败，请稍后重试');
      setPlan(body.plan);
      if (!dryRun && body.result) {
        setResult(body.result);
        if (body.result.completed) setStage('done');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '执行失败，请稍后重试');
    } finally {
      setBusy(null);
    }
  }

  if (stage === 'done' && result) {
    return (
      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <h2 className="text-lg font-semibold text-ink-900">
          {wasCompleted ? '重新初始化完成' : '初始化完成'}
        </h2>
        <p className="mt-2 text-sm text-ink-600">
          新建 {result.created} 项、更新 {result.updated} 项、跳过 {result.skipped} 项。接入指南里的模型 ID
          已经是最新；模型页的价格与折扣由网关目录缓存，约 45 秒后刷新。
          {wasCompleted ? '本次未勾选的模型保持原样，不会被删除。' : ''}
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link
            href="/models"
            className="rounded-control bg-brand-orange px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-orange-dark"
          >
            查看模型目录
          </Link>
          <Link
            href="/guide"
            className="rounded-full border border-line px-5 py-2.5 text-sm text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
          >
            下一步：把接入方式发给学生
          </Link>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-5">
      <section className="rounded-card border border-line bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-ink-900">1. 配置 {keyLabel}</h2>
          <span className="text-[11px] text-ink-400">清单版本 {presetVersion}</span>
        </div>
        <p className="mt-1 text-sm text-ink-500">
          上游：{providerName}（{providerBase}）。Key 只在服务端使用，不会写进页面或日志。
          {existingKeyHint
            ? ' 网关里已保存一把 Key，可以直接复用，也可以换成新的。'
            : initialState.providerExists
              ? ' 网关里已有该供应商，但没有可复用的 Key，请填写新的。'
              : ' 这是全新实例，提交后会创建供应商与模型路由。'}
        </p>

        {existingKeyHint && (
          <fieldset className="mt-4 space-y-2">
            <legend className="sr-only">Key 来源</legend>
            <label
              className={`flex cursor-pointer items-start gap-2 rounded-control border px-3 py-2.5 transition ${
                usingSavedKey ? 'border-ink-900 bg-cream-100/40' : 'border-line hover:border-ink-300'
              }`}
            >
              <input
                type="radio"
                name="key-mode"
                checked={usingSavedKey}
                onChange={() => switchKeyMode('saved')}
                className="mt-0.5 h-4 w-4 shrink-0 accent-black"
              />
              <span className="text-sm text-ink-700">
                复用网关里已保存的 Key
                <span className="mt-0.5 block text-xs text-ink-500">
                  上次初始化已写进网关：<span className="font-mono text-ink-700">{existingKeyHint}</span>
                  ，无需重新填写。
                </span>
              </span>
            </label>
            <label
              className={`flex cursor-pointer items-start gap-2 rounded-control border px-3 py-2.5 transition ${
                usingSavedKey ? 'border-line hover:border-ink-300' : 'border-ink-900 bg-cream-100/40'
              }`}
            >
              <input
                type="radio"
                name="key-mode"
                checked={!usingSavedKey}
                onChange={() => switchKeyMode('new')}
                className="mt-0.5 h-4 w-4 shrink-0 accent-black"
              />
              <span className="text-sm text-ink-700">
                换成新的 Key
                <span className="mt-0.5 block text-xs text-ink-500">
                  学校换了云账号，或旧 Key 已失效时选这个；提交后会覆盖网关里的旧 Key。
                </span>
              </span>
            </label>
          </fieldset>
        )}

        {usingSavedKey ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void runProbe()}
              disabled={probing}
              className="rounded-full bg-ink-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {probing ? '验证中…' : '用已保存的 Key 继续'}
            </button>
            <span className="text-xs text-ink-500">
              用网关里保存的 Key 向上游确认可用性并拉取模型列表，明文不会显示在页面上。
            </span>
          </div>
        ) : (
          <>
            <div className="mt-4 flex items-center justify-between gap-3">
              <label htmlFor="provider-key" className="text-sm font-medium text-ink-700">
                {keyLabel}
              </label>
              <a
                href={apiKeyUrl}
                target="_blank"
                rel="noreferrer"
                title="用学校自己的云账号登录后创建并复制；Key 只在服务端使用"
                className="shrink-0 whitespace-nowrap text-xs text-brand-link underline-offset-2 hover:underline"
              >
                还没有 Key？{keyLinkLabel} ↗
              </a>
            </div>
            <div className="mt-1.5 flex gap-2">
              <input
                id="provider-key"
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  // Key 一改就作废旧检测结果（含在途请求），避免用 A 的检测结论去写 B 的 Key
                  probeSeqRef.current += 1;
                  setProbe(null);
                  setProbing(false);
                  setStage('key');
                }}
                placeholder="sk-..."
                className="min-w-0 flex-1 rounded-control border border-line bg-white px-3 py-2 font-mono text-sm text-ink-900 outline-none transition focus:border-ink-300"
              />
              <button
                type="button"
                onClick={() => setShowKey((value) => !value)}
                className="rounded-control border border-line px-3 py-2 text-sm text-ink-600 transition hover:border-ink-300 hover:text-ink-900"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
              <button
                type="button"
                onClick={() => void runProbe()}
                disabled={probing || apiKey.trim().length < 8}
                className="rounded-control bg-ink-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {probing ? '检测中…' : '检测 Key'}
              </button>
            </div>
          </>
        )}

        {probe?.ok && (
          <p className="mt-3 rounded-control bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            {usingSavedKey ? '已保存的 Key 可用' : 'Key 可用'}（{probe.keyHint}，{probe.latencyMs}ms）
            {probe.models ? `；上游返回 ${probe.models.length} 个模型` : '；上游未开放模型列表，已用一次最小对话验证'}
            。
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 rounded-control bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
      </section>

      {stage !== 'key' && (
        <section className="rounded-card border border-line bg-white p-6 shadow-card">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-ink-900">2. 选择要导入的模型</h2>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => setSelected(new Set(models.filter((model) => model.featured).map((model) => model.id)))}
                className="rounded-full border border-line px-3 py-1 text-ink-600 transition hover:border-ink-300 hover:text-ink-900"
              >
                恢复推荐
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                className="rounded-full border border-line px-3 py-1 text-ink-600 transition hover:border-ink-300 hover:text-ink-900"
              >
                全不选
              </button>
            </div>
          </div>
          <p className="mt-1 text-sm text-ink-500">
            {catalogScope === 'tencent' ? (
              <>
                按模型类型逐类挑选，右侧实时显示已选结果。默认只勾选每个家族的主流模型；上游返回但推荐清单未预置的模型也在这里，
                参数与价格直接读取腾讯云官方模型目录（{MODEL_CATALOG_VERSION}，{MODEL_CATALOG_UPDATED_AT} 核对），无需手动填写。
                视频 / 3D / 音乐 / 语音等网关暂不支持的模型只展示、不可勾选。
              </>
            ) : (
              <>
                按模型类型逐类挑选，右侧实时显示已选结果。本次只接入清单内的热门模型，
                参数与价格来自{priceSourceLabel}，无需手动填写。标注「加权路由」的模型会与其它已接入云厂商的
                同款模型共用一个路由池，按权重分流。
              </>
            )}
          </p>
          {probe?.models && catalogScope === 'tencent' && (
            <p className="mt-1 text-xs text-ink-400">
              上游共 {probe.models.length} 个模型，其中 {upstreamCount} 个不在推荐清单里，已排在每类列表末尾。
            </p>
          )}
          {hiddenUpstreamCount > 0 && (
            <p className="mt-1 text-xs text-ink-400">
              上游另有 {hiddenUpstreamCount} 个模型未接入：当前只接热门模型，其余可在网关后台手动添加。
            </p>
          )}

          <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_264px]">
            <div className="min-w-0">
              <div className="flex flex-wrap gap-2" aria-label="模型类型">
                {groups.map((group, index) => {
                  const active = group.key === activeGroup?.key;
                  const picked = group.models.filter((model) => selected.has(model.id) && !model.unsupported).length;
                  return (
                    <button
                      key={group.key}
                      type="button"
                      onClick={() => setActiveCategory(group.key)}
                      aria-pressed={active}
                      className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition ${
                        active
                          ? 'border-ink-900 bg-ink-900 text-white'
                          : 'border-line text-ink-600 hover:border-ink-300 hover:text-ink-900'
                      }`}
                    >
                      {index + 1}. {group.meta.short}
                      <span className={`ml-1.5 ${active ? 'text-white/70' : 'text-ink-400'}`}>
                        {picked}/{group.models.length}
                      </span>
                    </button>
                  );
                })}
              </div>

              {activeGroup && (
                <>
                  <p className="mt-3 text-xs text-ink-500">
                    <span className="font-medium text-ink-700">{activeGroup.meta.label}</span>：{activeGroup.meta.hint}
                  </p>
                  <ul className="mt-2 divide-y divide-line rounded-control border border-line">
                    {activeGroup.models.map((model) => {
                      const missingUpstream =
                        model.source === 'preset' && upstreamModels ? !upstreamModels.has(model.id) : false;
                      const disabled = Boolean(model.unsupported);
                      const meta = [
                        model.vendor || null,
                        model.contextWindow ? `上下文 ${formatContext(model.contextWindow)}` : null,
                        model.maxTokens ? `最大输出 ${formatContext(model.maxTokens)}` : null,
                        model.priceText,
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <li key={model.id} className={`px-3 py-2.5 ${disabled ? 'opacity-60' : ''}`}>
                          <div className="flex items-start gap-3">
                            <input
                              id={`model-${model.id}`}
                              type="checkbox"
                              checked={selected.has(model.id)}
                              disabled={disabled}
                              title={model.unsupported ?? undefined}
                              onChange={() => toggle(model.id)}
                              className="mt-1 h-4 w-4 shrink-0 accent-black disabled:cursor-not-allowed"
                            />
                            <div className="min-w-0 flex-1">
                              <label
                                htmlFor={`model-${model.id}`}
                                className={`block ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                              >
                                <span className="flex flex-wrap items-center gap-2">
                                  <span className="text-sm font-medium text-ink-900">{model.displayName}</span>
                                  {model.displayName !== model.id && (
                                    <span className="font-mono text-[11px] text-ink-400">{model.id}</span>
                                  )}
                                  {model.featured && (
                                    <span className="rounded-full bg-brand-orange-soft px-2 py-0.5 text-[11px] text-brand-link">
                                      推荐
                                    </span>
                                  )}
                                  {model.shared && (
                                    <span
                                      title="同款模型在多个供应商之间共用一个路由池：腾讯云权重 8，阿里云 / 火山各 1，按 weight 分流"
                                      className="rounded-full bg-brand-yellow-soft px-2 py-0.5 text-[11px] text-amber-700"
                                    >
                                      加权路由
                                    </span>
                                  )}
                                  {model.source === 'upstream' && (
                                    <span className="rounded-full bg-cream-100 px-2 py-0.5 text-[11px] text-ink-500">
                                      清单外
                                    </span>
                                  )}
                                  {model.routeStatus === 'disabled' && (
                                    <span className="rounded-full bg-cream-100 px-2 py-0.5 text-[11px] text-ink-500">
                                      默认停用
                                    </span>
                                  )}
                                  {model.needsPostpaid && !disabled && (
                                    <span className="rounded-full bg-brand-yellow-soft px-2 py-0.5 text-[11px] text-amber-700">
                                      需开通后付费
                                    </span>
                                  )}
                                  {model.nonChat && (
                                    <span className="rounded-full bg-cream-100 px-2 py-0.5 text-[11px] text-ink-500">
                                      非对话
                                    </span>
                                  )}
                                  {missingUpstream && (
                                    <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-600">
                                      上游未见
                                    </span>
                                  )}
                                  {disabled && (
                                    <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] text-red-600">
                                      不可导入
                                    </span>
                                  )}
                                </span>
                                <span className="mt-1 block text-xs text-ink-500">
                                  {model.source === 'upstream'
                                    ? meta
                                    : `${model.vendor} · 上下文 ${formatContext(model.contextWindow)} · 输入 ${model.inputPrice} · 输出 ${model.outputPrice}${
                                        model.imagePrice ? ` · ${model.imagePrice}` : ''
                                      }`}
                                </span>
                                {model.unsupported && (
                                  <span className="mt-1 block text-xs text-red-600">{model.unsupported}</span>
                                )}
                              </label>
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ul>

                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => selectGroup(true)}
                        className="rounded-full border border-line px-3 py-1 text-ink-600 transition hover:border-ink-300 hover:text-ink-900"
                      >
                        全选本类
                      </button>
                      <button
                        type="button"
                        onClick={() => selectGroup(false)}
                        className="rounded-full border border-line px-3 py-1 text-ink-600 transition hover:border-ink-300 hover:text-ink-900"
                      >
                        清空本类
                      </button>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      <button
                        type="button"
                        onClick={() => goToGroup(-1)}
                        disabled={activeIndex <= 0}
                        className="rounded-full border border-line px-3 py-1 text-ink-600 transition hover:border-ink-300 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        上一类
                      </button>
                      <span className="text-ink-400">
                        {activeIndex + 1} / {groups.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => goToGroup(1)}
                        disabled={activeIndex >= groups.length - 1}
                        className="rounded-full border border-line px-3 py-1 text-ink-600 transition hover:border-ink-300 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        下一类
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

            <aside className="h-fit rounded-control border border-line bg-cream-100/50 p-3 lg:sticky lg:top-24">
              <div className="flex items-baseline justify-between">
                <span className="text-xs font-medium text-ink-900">已选模型</span>
                <span className="text-xs text-ink-500">
                  {selectedIds.length} / {displayModels.length}
                </span>
              </div>
              {selectedIds.length === 0 ? (
                <p className="mt-3 text-xs text-ink-500">还没有选择模型。可在左侧逐类勾选，或点「恢复推荐」。</p>
              ) : (
                <div className="mt-2 max-h-[420px] space-y-3 overflow-auto pr-1">
                  {groups.map((group) => {
                    const picked = group.models.filter((model) => selected.has(model.id) && !model.unsupported);
                    return (
                      <div key={group.key}>
                        <div className="flex items-center justify-between text-[11px] text-ink-500">
                          <span>{group.meta.label}</span>
                          <span>
                            {picked.length}/{group.models.length}
                          </span>
                        </div>
                        {picked.length > 0 && (
                          <ul className="mt-1 space-y-1">
                            {picked.map((model) => (
                              <li
                                key={model.id}
                                className="flex items-start justify-between gap-2 rounded bg-white px-2 py-1"
                              >
                                <span className="min-w-0 truncate text-[11px] text-ink-700" title={model.id}>
                                  {model.displayName}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => toggle(model.id)}
                                  aria-label={`移除 ${model.displayName}`}
                                  className="shrink-0 text-[11px] text-ink-400 transition hover:text-ink-900"
                                >
                                  ×
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </aside>
          </div>

          <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-control border border-line px-3 py-2.5">
            <input
              type="checkbox"
              checked={forceOverwrite}
              onChange={(event) => setForceOverwrite(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-black"
            />
            <span className="text-sm text-ink-700">
              强制覆盖已有配置
              <span className="mt-0.5 block text-xs text-ink-500">
                勾选后，网关里已存在的模型与路由会按推荐清单覆盖定价、上下文和折扣；不勾选则只补缺，保留运营改过的值。
              </span>
            </span>
          </label>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void submit(true)}
              disabled={busy !== null || !canSubmit}
              className="rounded-full border border-line px-4 py-2 text-sm text-ink-700 transition hover:border-ink-300 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'plan' ? '计算中…' : '预览变更'}
            </button>
            <button
              type="button"
              onClick={() => void submit(false)}
              disabled={busy !== null || !canSubmit}
              className="rounded-control bg-brand-orange px-5 py-2 text-sm font-semibold text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
            >
              {busy === 'apply'
                ? '写入网关中…'
                : wasCompleted
                  ? `重新执行（${selectedIds.length} 个模型）`
                  : `开始初始化（${selectedIds.length} 个模型）`}
            </button>
            <span className="text-xs text-ink-500">
              初始化会创建供应商、模型与路由，并设置账单币种为 CNY。
              {wasCompleted ? '重跑不勾「强制覆盖」时只补缺，不会删除未选中的模型。' : ''}
            </span>
          </div>

          {plan && (
            <div className="mt-5 rounded-control border border-line bg-cream-100/40 p-4">
              <div className="text-sm font-medium text-ink-900">
                变更预览：新建 {plan.summary.create} · 更新 {plan.summary.update} · 跳过 {plan.summary.skip}
              </div>
              <ul className="mt-2 max-h-64 space-y-1 overflow-auto text-xs text-ink-600">
                <li className="flex items-center gap-2">
                  <ActionBadge action={plan.provider.action} />
                  供应商 {plan.provider.id}
                  <span className="text-ink-400">{plan.provider.reasons.join('；')}</span>
                </li>
                {plan.config.map((item) => (
                  <li key={`config-${item.key}`} className="flex items-center gap-2">
                    <ActionBadge action={item.action} />
                    配置 {item.key} = {item.value}
                  </li>
                ))}
                {plan.models.map((item) => (
                  <li key={`model-${item.id}`} className="flex items-center gap-2">
                    <ActionBadge action={item.action} />
                    模型 {item.id}
                    <span className="text-ink-400">{item.reasons.join('；')}</span>
                  </li>
                ))}
                {plan.routes.map((item) => (
                  <li key={`route-${item.id}`} className="flex items-center gap-2">
                    <ActionBadge action={item.action} />
                    路由 {item.id}
                    <span className="text-ink-400">{item.reasons.join('；')}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result && !result.completed && (
            <div className="mt-4 rounded-control border border-red-200 bg-red-50 p-4 text-sm text-red-700">
              <div className="font-medium">有 {result.failed} 项失败，修正后可直接重试（已完成项会跳过）</div>
              <ul className="mt-2 space-y-1 text-xs">
                {result.steps
                  .filter((step) => !step.ok)
                  .map((step) => (
                    <li key={`${step.group}-${step.target}`}>
                      {step.group} · {step.target}：{step.message ?? '未知错误'}
                    </li>
                  ))}
              </ul>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 rounded-control bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
