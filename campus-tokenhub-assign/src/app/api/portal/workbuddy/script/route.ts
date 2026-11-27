import { NextResponse } from 'next/server';
import { getPublicProxyBase } from '@/lib/config';
import { loadChatModels } from '@/lib/guide/chat-models';
import {
  buildWorkBuddyEntry,
  buildWorkBuddyScript,
  type WorkBuddyModelEntry,
  type WorkBuddyScriptPlatform,
} from '@/lib/guide/workbuddy';

/**
 * `GET /api/portal/workbuddy/script?platform=mac|windows&models=id1,id2`
 *
 * 「方式一 · 复制命令执行」用的脚本来源：终端里没有 Cookie，所以身份靠请求头里的
 * `X-Api-Key` 自证，返回一份按该 Key 与模型清单现生成的接入脚本，直接管道给
 * bash / iex 执行。不落盘、不缓存，返回内容与「下载脚本」得到的 zip 内文件完全一致。
 *
 * **本接口不校验 Key 的归属与有效性**：网关只提供「按用户列 Key」，没有「按 Key
 * 反查归属」的端点，做不到真正的鉴权。Key 在这里的用途仅仅是**填充脚本正文**，
 * 返回的脚本对任何人都是同一份模板。所以把它当作公开资源对待：
 * - 靠 middleware 的按 IP 限流挡住刷取（60 次/分钟）；
 * - 只回文本，不含任何用户数据；
 * - Key 必须过字符白名单：它会被原样拼进 `curl -H 'X-Api-Key: …'` 这类命令，
 *   含引号/换行就等于给「复制执行的命令」注入（见 `buildWorkBuddyFetchCommand`）。
 *
 * 注意：Key 通过请求头传入，不要在这里打日志，避免把 Key 写进访问日志。
 */

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

/**
 * Key 允许的字符集：字母数字与 `._-`。
 *
 * 刻意收紧到「不含引号、反引号、`$`、空白、分号、管道」——即使下游生成函数漏了转义，
 * 这里的白名单也让注入无法构造。长度下限 8 是为了挡掉明显的垃圾值。
 */
const API_KEY_PATTERN = /^[A-Za-z0-9._-]{8,512}$/;

function fail(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: NO_STORE });
}

export async function GET(request: Request): Promise<NextResponse> {
  const apiKey = request.headers.get('x-api-key')?.trim() ?? '';
  if (!apiKey) {
    return fail('缺少 X-Api-Key 请求头', 401);
  }
  // 字符白名单：这个值会被原样拼进给用户执行的 shell / PowerShell 命令，
  // 允许任意字符等于开放命令注入。不合法就拒，不要试图转义后再放行。
  if (!API_KEY_PATTERN.test(apiKey)) {
    return fail('X-Api-Key 格式不合法', 400);
  }

  const url = new URL(request.url);
  const platform: WorkBuddyScriptPlatform = url.searchParams.get('platform') === 'windows' ? 'windows' : 'mac';
  // 不传 models 表示「全部对话模型」：默认全选时命令能短很多
  const wanted = (url.searchParams.get('models') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  // loadChatModels 自己会吞掉网关异常，返回空数组即代表目录当前不可用
  const models = await loadChatModels();
  if (models.length === 0) {
    return fail('模型目录暂不可用，请稍后重试', 503);
  }

  // WorkBuddy 只能调用输出文本的模型：不传 models 时也只写这批，
  // 显式点名嵌入 / 生图 / 语音类模型时按「无可用模型」拒绝，避免写进去也用不了。
  const usable = models.filter((model) => !model.workbuddyBlockedReason);
  if (usable.length === 0) {
    return fail('当前目录没有可接入 WorkBuddy 的文本模型', 503);
  }

  const picked = wanted.length > 0 ? usable.filter((model) => wanted.includes(model.id)) : usable;
  if (picked.length === 0) {
    return fail('未匹配到可接入 WorkBuddy 的文本模型，请检查 models 参数', 400);
  }

  // 脚本里的模型地址必须是浏览器/客户端可达的绝对地址；留空会写成 `/v1/chat/completions`，
  // 生成出来的配置文件在任何机器上都跑不通，所以直接拒绝而不是返回半成品。
  const proxyBase = getPublicProxyBase();
  if (!proxyBase) {
    return fail('门户未配置接口地址（NEXT_PUBLIC_PROXY_BASE），无法生成接入脚本', 503);
  }

  const endpoint = `${proxyBase}/v1/chat/completions`;
  const entries: WorkBuddyModelEntry[] = picked.map((model) =>
    buildWorkBuddyEntry({
      modelId: model.id,
      modelName: model.name,
      endpoint,
      apiKey,
      supportsImages: model.supportsImages,
      supportsReasoning: model.supportsReasoning,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
    })
  );

  // Windows 脚本为文件执行准备了 BOM，直接喂给 iex 会多一个不可见字符，这里去掉
  const script = buildWorkBuddyScript(platform, entries).replace(/^\uFEFF/, '');

  return new NextResponse(script, {
    headers: { ...NO_STORE, 'content-type': 'text/plain; charset=utf-8' },
  });
}
