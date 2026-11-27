import { NextResponse } from 'next/server';
import { ApiError, assertMethod, assertSameOrigin, jsonError, requireSession } from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { requireSetupAccess } from '@/lib/onboarding/access';
import { revealProviderApiKey } from '@/lib/onboarding/gateway-state';
import { getProvider, parseProviderKey } from '@/lib/onboarding/providers';
import { probeUpstream } from '@/lib/onboarding/probe';
import { normalizeApiKey } from '@/lib/onboarding/validate';

/**
 * 探测学校的供应商 Key：能不能连、有哪些模型。
 *
 * 两种来源：
 * - `apiKey`：管理员这次新填的 Key
 * - `useExisting: true`：复用网关 providers 表里已保存的 Key（服务端用 admin 接口取明文，只在内存里用）
 *
 * `provider` 决定探测哪个上游（`tencent` / `aliyun` / `volcano`），缺省按腾讯云。
 * 返回里只有掩码指纹（`sk-…abcd`），前端用它让管理员确认用的是哪一把。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireSetupAccess(session);

    const body = (await request.json().catch(() => ({}))) as {
      apiKey?: unknown;
      useExisting?: unknown;
      provider?: unknown;
    };

    const providerKey = parseProviderKey(body.provider);
    if (!providerKey) throw new ApiError(400, '不支持的供应商', 'invalid_provider');
    const provider = getProvider(providerKey);

    let apiKey: string;
    if (body.useExisting === true) {
      const stored = await revealProviderApiKey(provider.preset.provider.id);
      if (!stored) {
        throw new ApiError(400, `网关里没有可复用的 Key，请填写新的 ${provider.keyLabel}`, 'no_stored_api_key');
      }
      apiKey = stored;
    } else {
      apiKey = normalizeApiKey(body.apiKey);
    }

    const result = await probeUpstream(apiKey, { preset: provider.preset });

    audit('onboarding.probe', {
      actor_email: session.email,
      actor_external_id: session.sub,
      target: `${providerKey}:${result.keyHint}`,
      result: result.ok ? 'success' : 'fail',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return NextResponse.json({ result });
  } catch (error) {
    return jsonError(error);
  }
}
