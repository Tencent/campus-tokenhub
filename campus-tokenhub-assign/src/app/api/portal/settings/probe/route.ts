/**
 * 配置探测接口。
 *
 * 接受「草稿值」，因此用户填完 Key 就能测，不必先保存。
 * 探测不改任何业务配置、不写日志，响应里也不会出现密钥明文；
 * 只有「对已保存的配置做探测」（草稿为空）时，把结论记进分组验证状态供设置页徽标展示。
 *
 * 限流：同一身份 10 秒内只能探测一次，避免反复点按钮把腾讯云接口打满。
 */

import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  requireSession,
} from '@/lib/api/guard';
import { requireSettingsAdmin } from '@/lib/config/settings-access';
import {
  probeAdminIdentity,
  probeCurrency,
  type ProbeDraft,
  type ProbeGroup,
  type ProbeOutcome,
} from '@/lib/config/probe';
import { setVerifyState } from '@/lib/config/store';
import {
  ProbeRateLimitError,
  assertProbeRateLimit,
} from '@/lib/config/probe-rate-limit';

export const dynamic = 'force-dynamic';

/** 单次探测整体超时：上游再慢也不让页面一直转圈 */
const PROBE_TIMEOUT_MS = 8_000;

/** 设置页只有币种分组有验证徽标；admin 探测结果不落库 */
const BADGE_GROUP: Partial<Record<ProbeGroup, 'currency'>> = {
  currency: 'currency',
};

/** 带了草稿就是在测「还没保存的值」，此时不能改写已保存配置的验证状态 */
function usesDraft(draft: ProbeDraft): boolean {
  return Boolean(draft.sub);
}

function parsePayload(body: unknown): { group: ProbeGroup; draft: ProbeDraft } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, '请求体不是合法 JSON', 'invalid_body');
  }

  const record = body as Record<string, unknown>;
  const group = typeof record.group === 'string' ? record.group : '';
  const allowed: ProbeGroup[] = ['currency', 'admin'];
  if (!allowed.includes(group as ProbeGroup)) {
    throw new ApiError(400, `不支持的探测分组：${group || '空'}`, 'unsupported_group');
  }

  const rawDraft = record.draft;
  const draft: ProbeDraft = {};
  if (rawDraft && typeof rawDraft === 'object' && !Array.isArray(rawDraft)) {
    const values = rawDraft as Record<string, unknown>;
    for (const key of ['sub'] as const) {
      if (typeof values[key] === 'string') draft[key] = values[key] as string;
    }
  }
  return { group: group as ProbeGroup, draft };
}

async function dispatch(group: ProbeGroup, draft: ProbeDraft): Promise<ProbeOutcome> {
  switch (group) {
    case 'currency':
      return probeCurrency();
    case 'admin':
      return probeAdminIdentity(draft);
    default:
      return { ok: false, code: 'unsupported_group', message: '不支持的探测分组' };
  }
}

async function withTimeout(group: ProbeGroup, draft: ProbeDraft): Promise<ProbeOutcome> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      dispatch(group, draft),
      new Promise<ProbeOutcome>((resolve) => {
        timer = setTimeout(
          () => resolve({ ok: false, code: 'probe_timeout', message: '探测超时，请稍后重试' }),
          PROBE_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireSettingsAdmin(session);
    try {
      assertProbeRateLimit(session.sub);
    } catch (error) {
      if (error instanceof ProbeRateLimitError) {
        throw new ApiError(429, error.message, 'probe_too_frequent');
      }
      throw error;
    }

    const payload = parsePayload(await request.json().catch(() => null));
    const outcome = await withTimeout(payload.group, payload.draft);

    // 只记录「对已保存配置」的结论：草稿探测不改写已保存配置的验证状态
    const badge = BADGE_GROUP[payload.group];
    if (badge && !usesDraft(payload.draft)) {
      await setVerifyState(badge, outcome.ok ? 'ok' : 'failed', outcome.message ?? null);
    }

    if (!outcome.ok) {
      const status = outcome.code === 'probe_timeout' ? 504 : 400;
      return NextResponse.json(
        {
          error: outcome.message,
          code: outcome.code ?? 'probe_failed',
          detail: outcome.detail ?? null,
        },
        { status, headers: { 'cache-control': 'no-store' } }
      );
    }

    return NextResponse.json(
      { ok: true, group: payload.group, message: outcome.message ?? null, detail: outcome.detail ?? null },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
