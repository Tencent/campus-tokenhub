import Link from 'next/link';
import { requireCurrentSession } from '@/lib/auth/current';
import { canAccessSetup, getSetupAccess } from '@/lib/onboarding/access';
import {
  DEFAULT_PROVIDER_KEY,
  defaultSelectedIds,
  getProvider,
  parseProviderKey,
  type ProviderKey,
} from '@/lib/onboarding/providers';
import { getProviderStates } from '@/lib/onboarding/state';
import { isSharedModel } from '@/lib/onboarding/shared-routing';
import { resolveCurrentPrice } from '@/lib/pricing/schedule';
import { formatPointsUnitPrice } from '@/lib/portal/points';
import { resolveModelCategory } from '@/lib/onboarding/model-category';
import { SetupClient, type SetupModelOption } from '@/components/setup/SetupClient';
import type { OnboardingPreset } from '@/lib/onboarding/types';

export const dynamic = 'force-dynamic';

function buildOptions(preset: OnboardingPreset, featuredIds: string[], at: Date): SetupModelOption[] {
  return preset.models.map((model) => {
    const price = resolveCurrentPrice(model.pricingProfile, at);
    const outputs = model.outputModalities ?? [];
    return {
      id: model.id,
      displayName: model.displayName ?? model.id,
      vendor: model.vendor,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      inputPrice: formatPointsUnitPrice(price.inputPrice, 'M'),
      outputPrice: formatPointsUnitPrice(price.outputPrice, 'M'),
      imagePrice: price.imagePrice === null ? null : formatPointsUnitPrice(price.imagePrice, '张'),
      recommended: model.recommended,
      featured: featuredIds.includes(model.id),
      needsPostpaid: model.needsPostpaid,
      routeStatus: model.route.status,
      nonChat: !outputs.includes('text'),
      category: resolveModelCategory(model.outputModalities),
      shared: isSharedModel(model.id),
    };
  });
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div className="rounded-card border border-line bg-white p-6 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">{title}</h1>
        <div className="mt-2 space-y-2 text-sm text-ink-600">{children}</div>
        <Link
          href="/overview"
          className="mt-5 inline-block rounded-full border border-line px-4 py-1.5 text-sm text-ink-700 transition hover:border-ink-300 hover:text-ink-900"
        >
          返回我的算力
        </Link>
      </div>
    </div>
  );
}

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ provider?: string | string[] }>;
}) {
  const session = await requireCurrentSession();
  const params = await searchParams;
  const rawProvider = Array.isArray(params.provider) ? params.provider[0] : params.provider;
  const providerKey: ProviderKey = parseProviderKey(rawProvider) ?? DEFAULT_PROVIDER_KEY;

  // 先判权限再读状态：非管理员不能在这里认领 owner
  if (!(await canAccessSetup(session))) {
    return (
      <Notice title="初始化仅对管理员开放">
        <p>当前账号不是全局管理员。需要初始化或调整网关配置时，请联系学校管理员操作。</p>
      </Notice>
    );
  }

  let access;
  let providerStates;
  try {
    [access, providerStates] = await Promise.all([getSetupAccess(session), getProviderStates()]);
  } catch {
    return (
      <Notice title="暂时读不到网关状态">
        <p>门户无法连接网关管理端，请确认容器已启动、`OCTAFUSE_ADMIN_*` 配置正确后刷新重试。</p>
      </Notice>
    );
  }

  if (!access.isOwner) {
    return (
      <Notice title="初始化已由其他账号接管">
        <p>当前网关的初始化负责人是：{access.owner ?? '未知账号'}。</p>
        <p>请让该账号完成初始化，或清空网关里的 `ONBOARDING_OWNER` 配置后重新进入。</p>
      </Notice>
    );
  }

  const provider = getProvider(providerKey);
  const current = providerStates.find((item) => item.provider.key === providerKey) ?? providerStates[0];
  const state = current.state;
  const completedAtText = state.completedAt ? new Date(state.completedAt).toLocaleString('zh-CN') : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <header>
        <h1 className="text-[26px] font-semibold leading-9 tracking-tight text-ink-900">
          {state.completed ? '重新初始化' : '初始化'}
        </h1>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-500">
          用学校自己的{provider.tagline} Key 把推荐模型清单一次性写入网关。Key 只写进网关的
          providers 表，门户不保存、不回显；中途重跑可以直接复用已保存的 Key。
        </p>

        <nav className="mt-4 flex flex-wrap gap-2" aria-label="供应商">
          {providerStates.map(({ provider: item, state: itemState }) => {
            const active = item.key === providerKey;
            return (
              <Link
                key={item.key}
                href={`/setup?provider=${item.key}`}
                aria-current={active ? 'page' : undefined}
                className={`rounded-full border px-3 py-1.5 text-xs transition ${
                  active
                    ? 'border-ink-900 bg-ink-900 text-white'
                    : 'border-line text-ink-600 hover:border-ink-300 hover:text-ink-900'
                }`}
              >
                {item.label}
                <span className={`ml-1.5 ${active ? 'text-white/70' : 'text-ink-400'}`}>
                  {itemState.completed ? '已完成' : '未初始化'}
                </span>
              </Link>
            );
          })}
        </nav>

        {state.completed && (
          <p className="mt-3 rounded-control border border-line bg-white px-4 py-3 text-xs leading-relaxed text-ink-600">
            本网关的{provider.tagline}已完成初始化{completedAtText ? `（${completedAtText}）` : ''}，当前有{' '}
            {state.modelCount} 个清单模型、{state.routeCount} 条路由。可以继续重跑：只补缺与更新勾选项，
            <strong>未勾选的模型不会被删除</strong>；换 Key 时选「换成新的 Key」，提交后会覆盖网关里的旧 Key。
          </p>
        )}
      </header>

      {/*
        key 必须是 provider.key：切换供应商只是 searchParams 变化，SetupClient 位置不变会被 React 复用，
        内部的 stage / result / probe / selected 会串到新供应商上（阿里云做完再切火山仍显示「初始化完成」）。
      */}
      <SetupClient
        key={provider.key}
        providerKey={provider.key}
        keyLabel={provider.keyLabel}
        keyLinkLabel={provider.keyLinkLabel}
        catalogScope={provider.catalogScope}
        priceSourceLabel={provider.priceSourceLabel}
        presetVersion={provider.preset.version}
        providerName={provider.preset.provider.name}
        apiKeyUrl={provider.apiKeyUrl}
        providerBase={String(
          (provider.preset.provider.endpoints as { openai?: { base?: string } }).openai?.base ?? ''
        )}
        models={buildOptions(provider.preset, provider.featuredIds, new Date())}
        defaultSelected={
          state.completed && state.enabledModelIds.length > 0
            ? // 重跑时默认勾上「已启用的 + 默认推荐但还没建的」，方便直接补选新上线的模型
              [...new Set([...state.enabledModelIds, ...defaultSelectedIds(providerKey)])]
            : defaultSelectedIds(providerKey)
        }
        initialState={{
          completed: state.completed,
          providerExists: state.providerExists,
          existingKeyHint: state.existingKeyHint,
          modelCount: state.modelCount,
          routeCount: state.routeCount,
          gatewaySeeded: state.gatewaySeeded,
        }}
      />
    </div>
  );
}
