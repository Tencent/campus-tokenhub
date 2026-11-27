/**
 * 运行期配置的读写接口。
 *
 * - `GET` 返回当前生效值：非敏感项给原值，敏感项只给「是否已配置 + 尾号」；
 * - `PUT` 整份校验后写入，成功后立即刷新 overlay，下一次 `getConfig()` 就是新值。
 */

import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  requireSession,
} from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { requireSettingsAdmin } from '@/lib/config/settings-access';
import { loadSettingsPayload } from '@/lib/config/settings-view';
import { getConfig } from '@/lib/config';
import { mergeDraftAuth, validateAuthSectionErrors } from '@/lib/config/auth-validate';
import { isPasswordSessionAllowed } from '@/lib/auth/local-admin';
import { revokeSessionsFor } from '@/lib/auth/revocation';
import {
  ConfigStoreError,
  applyConfigChanges,
} from '@/lib/config/store';
import { invalidateConfigOverlay, refreshConfigOverlay } from '@/lib/config/overlay';
import {
  FIELDS,
  isConfigField,
  type ConfigField,
} from '@/lib/config/fields';

export const dynamic = 'force-dynamic';

/** 当前配置（敏感项脱敏）。 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['GET']);
    const session = await requireSession(request);
    await requireSettingsAdmin(session);

    const payload = await loadSettingsPayload();
    return NextResponse.json(payload, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

type SettingsPayload = {
  values: Partial<Record<ConfigField, unknown>>;
  clear: ConfigField[];
};

function parsePayload(body: unknown): SettingsPayload {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, '请求体不是合法 JSON', 'invalid_body');
  }

  const record = body as Record<string, unknown>;
  const rawValues = record.values;
  if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues)) {
    throw new ApiError(400, 'values 应为对象', 'invalid_values');
  }

  const values: Partial<Record<ConfigField, unknown>> = {};
  for (const [key, value] of Object.entries(rawValues)) {
    if (!isConfigField(key)) throw new ApiError(400, `未知的配置字段：${key}`, 'unknown_key');
    values[key] = value;
  }

  const rawClear = record.clear;
  const clear: ConfigField[] = [];
  if (Array.isArray(rawClear)) {
    for (const item of rawClear) {
      if (!isConfigField(item)) throw new ApiError(400, `未知的配置字段：${String(item)}`, 'unknown_key');
      clear.push(item);
    }
  }

  return { values, clear };
}

function mapStoreError(error: ConfigStoreError): ApiError {
  const message = error.message;
  if (message.includes('只读')) return new ApiError(400, message, 'readonly_key');
  if (message.includes('未注册')) return new ApiError(400, message, 'unknown_key');
  return new ApiError(400, message, 'invalid_settings');
}

/**
 * 保存前拦截：auth 相关键按「当前生效值 + 草稿 + clear」构造最终 auth 后做专项校验。
 * 非法协议必须在此被拒，不能只依赖运行时守卫。
 */
function assertAuthSettings(payload: SettingsPayload): void {
  const touched = [...Object.keys(payload.values), ...payload.clear].some((field) =>
    FIELDS[field as ConfigField]?.section === 'login'
  );
  if (!touched) return;

  const merged = mergeDraftAuth(getConfig().auth, payload.values, payload.clear);
  const errors = validateAuthSectionErrors(merged, process.env.NODE_ENV ?? '');
  if (errors.length > 0) {
    throw new ApiError(400, errors.map((error) => error.message).join('；'), 'auth_unsafe');
  }
}

/** 覆盖写整份配置：先校验再落库，成功后立即刷新运行期配置。 */
export async function PUT(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['PUT']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireSettingsAdmin(session);

    const payload = parsePayload(await request.json().catch(() => null));
    const actor = { sub: session.sub, ip: clientIp(request.headers) };

    assertAuthSettings(payload);

    try {
      // 同一事务里完成「写入 + 清除」：分开执行会留下半套配置（写成功、清除失败）
      await applyConfigChanges({
        values: payload.values,
        clear: payload.clear,
        ...actor,
      });
    } catch (error) {
      if (error instanceof ConfigStoreError) throw mapStoreError(error);
      throw error;
    } finally {
      // 库可能已经改了一部分（或事务已提交但刷新失败）：内存配置必须重读，
      // 否则进程会继续用旧值，页面看起来「保存失败」但实际已生效/已半生效
      invalidateConfigOverlay();
    }

    await refreshConfigOverlay();

    // 后门收口（第二层）：本次保存让 SSO 变齐全时，引导期密码会话立即作废。
    // 请求期 gate 会在下一个请求就拦住它，这里再落一条吊销记录，跨副本与 API 路径一起生效。
    const loginClosed =
      session.login_method === 'password' && !isPasswordSessionAllowed(session);
    if (loginClosed) {
      await revokeSessionsFor(session.sub).catch(() => undefined);
    }

    // 保存不再自动探测：外部系统（腾讯云 / 网关计费）的校验由用户点「验证」按钮触发，
    // 避免每次保存都打一次上游接口、并在没改凭据时把徽标状态刷成不相关的结论
    audit('config.change', {
      actor_external_id: session.sub,
      target: 'portal.settings',
      result: 'success',
      detail: [...Object.keys(payload.values), ...payload.clear].join(',').slice(0, 200),
      ip: actor.ip,
    });

    // 只在真的关闭了引导入口时多带一个字段：老调用方按 `{ ok: true }` 断言，保持兼容
    return NextResponse.json(
      loginClosed ? { ok: true, login_closed: true } : { ok: true },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
