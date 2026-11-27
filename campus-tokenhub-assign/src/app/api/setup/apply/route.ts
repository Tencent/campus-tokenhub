import { NextResponse } from 'next/server';
import { ApiError, assertMethod, assertSameOrigin, jsonError, requireSession } from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { requireSetupAccess } from '@/lib/onboarding/access';
import { applyOnboarding } from '@/lib/onboarding/apply';
import { getProvider, parseProviderKey } from '@/lib/onboarding/providers';
import { normalizeApiKey, normalizeExtraModels, normalizeModelIds } from '@/lib/onboarding/validate';

/**
 * 执行初始化（或只预览计划）。
 *
 * `dryRun: true` 返回 diff，不写任何东西；正式执行时逐条返回 created/updated/skipped/failed。
 * `provider` 缺省按腾讯云；每个供应商各自写完成标记，只有全部成功才写。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireSetupAccess(session);

    const body = (await request.json().catch(() => ({}))) as {
      apiKey?: unknown;
      modelIds?: unknown;
      extraModels?: unknown;
      forceOverwrite?: unknown;
      dryRun?: unknown;
      provider?: unknown;
    };

    const providerKey = parseProviderKey(body.provider);
    if (!providerKey) throw new ApiError(400, '不支持的供应商', 'invalid_provider');
    const provider = getProvider(providerKey);

    const dryRun = body.dryRun === true;
    const extraModels = normalizeExtraModels(body.extraModels, provider.preset);
    const modelIds = normalizeModelIds(
      body.modelIds,
      new Set(extraModels.map((model) => model.id)),
      provider.preset
    );
    const apiKey = body.apiKey === undefined || body.apiKey === null || body.apiKey === ''
      ? null
      : normalizeApiKey(body.apiKey);
    const forceOverwrite = body.forceOverwrite === true;

    const outcome = await applyOnboarding({
      selectedModelIds: modelIds,
      extraModels,
      apiKey,
      forceOverwrite,
      subject: session.sub,
      dryRun,
      preset: provider.preset,
    });

    const result = outcome.result;
    audit('onboarding.apply', {
      actor_email: session.email,
      actor_external_id: session.sub,
      target: `${providerKey}:${dryRun ? 'dry-run' : result?.completed ? 'completed' : 'partial'}`,
      result: dryRun ? 'success' : result?.ok ? 'success' : 'fail',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return NextResponse.json({ plan: outcome.plan, result });
  } catch (error) {
    return jsonError(error);
  }
}
