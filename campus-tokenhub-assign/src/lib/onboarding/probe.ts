/**
 * 上游探测：拿学校录入的 Key 直接问 TokenHub「这把 Key 能用吗、有哪些模型」。
 *
 * 只做两件事，不写库：
 * 1. `GET {base}/models` 拿模型 id（有的上游不开放这个接口）
 * 2. 接口不可用时退化为一次 8 token 的最小对话，至少证明 Key 能出字
 *
 * Key 只在请求头里出现，错误信息统一映射成中文，绝不回显。
 */

import type { ProbeResult, OnboardingPreset } from './types';
import { CURRENT_PRESET } from './preset';
import { assertOutboundAllowed } from '@/lib/security/url-guard';

const DEFAULT_TIMEOUT_MS = 12_000;

export type ProbeOptions = {
  preset?: OnboardingPreset;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '***';
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

function openaiBase(preset: OnboardingPreset): string {
  const endpoints = preset.provider.endpoints as { openai?: { base?: string } };
  return String(endpoints.openai?.base ?? '').replace(/\/+$/, '');
}

function mapHttpError(status: number, detail?: string | null): string {
  const base =
    status === 401
      ? 'Key 无效或已失效（401）'
      : status === 403
        ? 'Key 无权访问该资源（403），请确认已开通对应模型权限'
        : status === 404
          ? '上游地址或模型不可用（404），请确认 Base URL 与模型已开通'
          : status === 429
            ? 'Key 被限流或额度不足（429）'
            : status >= 500
              ? `上游服务异常（${status}）`
              : `上游返回 HTTP ${status}`;
  return detail ? `${base}：${detail}` : base;
}

/** 上游错误体里的可读信息；统一脱敏 + 截断，绝不回显完整 Key。 */
function readErrorDetail(payload: unknown): string | null {
  const record = payload as
    | { error?: { message?: unknown } | string; message?: unknown; code?: unknown }
    | null;
  const raw =
    (typeof record?.error === 'object' ? record?.error?.message : record?.error) ??
    record?.message ??
    null;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return raw
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function extractModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : ((payload as { data?: unknown } | null)?.data as unknown[] | undefined) ?? [];
  const ids = list
    .map((item) => (item as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  return [...new Set(ids)];
}

async function tryChat(
  base: string,
  modelId: string,
  apiKey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal
): Promise<{ ok: boolean; status: number; detail: string | null }> {
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'ping' }],
    }),
    cache: 'no-store',
    signal,
  });
  if (response.ok) return { ok: true, status: response.status, detail: null };
  const payload = await response.json().catch(() => null);
  return { ok: false, status: response.status, detail: readErrorDetail(payload) };
}

/**
 * `/models` 不可用（部分供应商不开放）时的兜底探测模型。
 * 只取对话模型：向量 / 图像模型走不同接口，拿它们 ping 只会得到 404。
 */
function fallbackModels(preset: OnboardingPreset): string[] {
  const chat = preset.models.filter((model) => model.route.upstreamOperation === 'chat');
  const ordered = [...chat.filter((model) => model.recommended), ...chat];
  return [...new Set(ordered.map((model) => model.id))].slice(0, 3);
}

export async function probeUpstream(apiKey: string, options: ProbeOptions = {}): Promise<ProbeResult> {
  const preset = options.preset ?? CURRENT_PRESET;
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = openaiBase(preset);
  const keyHint = maskKey(apiKey);
  const startedAt = Date.now();

  if (!base) {
    return { ok: false, models: null, keyHint, latencyMs: 0, error: '推荐清单里没有可用的上游地址' };
  }

  // 探测会带着学校 Key 发请求：地址来自预设清单（将来可能开放成可填），
  // 统一先过一遍「不许打本机 / 云元数据」的守卫
  const guarded = await assertOutboundAllowed(base, '上游地址');
  if (!guarded.ok) {
    return { ok: false, models: null, keyHint, latencyMs: 0, error: guarded.message };
  }

  const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const modelsResponse = await fetchImpl(`${base}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      cache: 'no-store',
      signal,
    });

    if (modelsResponse.ok) {
      const payload = await modelsResponse.json().catch(() => null);
      const ids = extractModelIds(payload);
      // 少数上游会返回 200 + 空列表；此时不能算探测通过，继续用最小对话确认
      if (ids.length > 0) {
        return { ok: true, models: ids, keyHint, latencyMs: Date.now() - startedAt };
      }
    }

    // 模型列表接口可能被上游关掉（404/405）或返回空列表；用最小对话兜底验证 Key。
    let lastStatus = modelsResponse.status;
    let lastDetail: string | null = null;
    for (const modelId of fallbackModels(preset)) {
      const chat = await tryChat(base, modelId, apiKey, fetchImpl, signal);
      if (chat.ok) {
        return { ok: true, models: null, keyHint, latencyMs: Date.now() - startedAt };
      }
      lastStatus = chat.status;
      lastDetail = chat.detail;
    }

    return {
      ok: false,
      models: null,
      keyHint,
      latencyMs: Date.now() - startedAt,
      error: mapHttpError(lastStatus, lastDetail),
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return {
      ok: false,
      models: null,
      keyHint,
      latencyMs: Date.now() - startedAt,
      error: timedOut ? '连接上游超时，请检查网络或 Base URL' : '无法连接上游地址，请检查网络或 Base URL',
    };
  }
}
