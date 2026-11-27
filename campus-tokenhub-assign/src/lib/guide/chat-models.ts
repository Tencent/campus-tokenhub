import { getCatalog, listChatModels, type ChatModelOption } from '@/lib/gateway/catalog';
import { resolveCatalogCategories, type CatalogCategoryKey } from '@/lib/gateway/catalog-category';
import { catalogSupportsReasoning } from '@/lib/onboarding/model-catalog';
import type { GuideModel } from './workbuddy';

/**
 * 不能接 WorkBuddy 的模型类别与原因。
 *
 * WorkBuddy 只按 OpenAI 兼容的对话协议调用模型（`/v1/chat/completions`），
 * 只有「输出文本」的模型能接；向量嵌入、文生图 / 文生视频、语音合成、纯语音转写
 * 即使有路由也接不进去，页面上要置灰并说明可以怎么用。
 */
const BLOCKED_CATEGORY_REASON: Partial<Record<CatalogCategoryKey, string>> = {
  embedding: '向量嵌入模型（输出向量）',
  image: '文生图模型（输出图片）',
  video: '文生视频模型（输出视频）',
  tts: '语音合成模型（输出语音）',
  asr: '语音识别模型（只做语音转写）',
};

/**
 * 「接入指南」要用到的对话模型清单（含 WorkBuddy 配置文件需要的能力字段）。
 *
 * 数据源优先级：管理端（刚初始化/导入的模型立即可见）→ 公开目录
 * （公开目录有网关 45 秒 + 门户 15 秒缓存，可能略滞后）。
 * 目录里读不到的字段（图片输入、上下文长度、输出模态）留空，由客户端按提供商默认值处理，绝不瞎猜。
 * 思考能力网关不返回（见 `packages/proxy/src/routes/v1/models.ts`），改用官方模型目录
 * （`model-catalog.ts`）的「深度思考」标注。
 *
 * 页面与「一条命令接入」接口共用这一份，避免两处各写一套、慢慢长歪。
 */
export async function loadChatModels(): Promise<GuideModel[]> {
  const [adminModels, snapshot] = await Promise.all([
    listChatModels().catch((): ChatModelOption[] => []),
    getCatalog().catch(() => null),
  ]);

  const catalogModels = snapshot?.models ?? [];
  const byId = new Map(catalogModels.map((model) => [model.id, model]));
  const options: ChatModelOption[] =
    adminModels.length > 0
      ? adminModels
      : catalogModels
          .filter((model) => (model.inbound ?? []).some((item) => item.operation === 'chat'))
          .map((model) => ({
            id: model.id,
            name: model.display_name || model.id,
            inputModalities: model.input_modalities ?? [],
            outputModalities: model.output_modalities ?? [],
          }));

  return options.map((option) => {
    const meta = byId.get(option.id);
    // 管理端的模态字段最新（刚导入的模型公开目录还看不到），读不到再退回公开目录
    const inputModalities =
      option.inputModalities.length > 0 ? option.inputModalities : (meta?.input_modalities ?? []);
    const outputModalities =
      option.outputModalities.length > 0 ? option.outputModalities : (meta?.output_modalities ?? []);

    const categories = resolveCatalogCategories({
      id: option.id,
      display_name: option.name,
      input_modalities: inputModalities,
      output_modalities: outputModalities,
    });
    const blocked = categories
      .map((category) => BLOCKED_CATEGORY_REASON[category])
      .find((reason): reason is string => Boolean(reason));

    return {
      id: option.id,
      name: option.name,
      supportsImages: inputModalities.includes('image'),
      // 网关不返回思考能力（`/v1/models` 明确交给客户端维护），按官方模型目录的
      // 「深度思考」标注判断；目录里没有的模型按不支持处理，不瞎猜。
      supportsReasoning: catalogSupportsReasoning(option.id),
      maxInputTokens: meta?.context_window ?? null,
      maxOutputTokens: meta?.max_tokens ?? null,
      workbuddyBlockedReason: blocked ?? null,
    };
  });
}
