import { NextResponse } from 'next/server';
import { ApiError, jsonError, jsonNoStore, requireSession } from '@/lib/api/guard';
import { canAccessSetup, getSetupAccess } from '@/lib/onboarding/access';
import { defaultSelectedIds, getProvider, parseProviderKey } from '@/lib/onboarding/providers';
import { getOnboardingState } from '@/lib/onboarding/state';

/**
 * 初始化状态：给页面判断「要不要跳初始化」「当前账号是不是 owner」。
 *
 * GET 会触发 owner 认领（没有 owner 时把当前身份写进去），
 * 这也是「第一个登录的人成为初始化负责人」的落地点；非管理员不参与认领。
 * `provider` 缺省按腾讯云，返回该供应商自己的完成状态与模型清单信息。
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request);
    if (!(await canAccessSetup(session))) {
      throw new ApiError(403, '初始化仅对全局管理员开放', 'not_setup_admin');
    }

    const providerKey = parseProviderKey(new URL(request.url).searchParams.get('provider'));
    if (!providerKey) throw new ApiError(400, '不支持的供应商', 'invalid_provider');
    const provider = getProvider(providerKey);

    const [access, state] = await Promise.all([
      getSetupAccess(session),
      getOnboardingState(undefined, provider.preset),
    ]);

    return jsonNoStore({
      ...state,
      provider: providerKey,
      // Key 指纹只给初始化负责人看，其他身份没必要知道学校密钥的尾号
      existingKeyHint: access.isOwner ? state.existingKeyHint : null,
      isOwner: access.isOwner,
      claimed: access.claimed,
      owner: access.owner,
      presetVersion: provider.preset.version,
      presetModelCount: provider.preset.models.length,
      defaultSelectedModelIds: defaultSelectedIds(providerKey),
    });
  } catch (error) {
    return jsonError(error);
  }
}
