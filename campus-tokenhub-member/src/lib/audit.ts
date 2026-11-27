/**
 * 审计日志：一行一个 JSON，直接进容器 stdout，由 Loki / CLS 采集。
 *
 * 两条铁律：
 * 1. 不写 API Key 明文（`sk-…` 一律打成 `sk-***`）
 * 2. 不写管理员密码 / 会话密钥（配置里的值出现就替换成 `***`）
 *
 * 缺省字段统一填 null，避免下游按 `undefined` 判断时字段时有时无。
 */

import { getConfig } from '@/lib/config';
import { runtimeSecrets } from '@/lib/config/secrets';
import { clientIpFromHeaders } from '@/lib/net/client-ip';

export type AuditEvent =
  | 'auth.login'
  | 'auth.login.fail'
  | 'provision.success'
  | 'provision.fail'
  | 'key.create'
  | 'key.revoke'
  | 'activity.claim'
  | 'activity.config'
  | 'config.change'
  | 'onboarding.probe'
  | 'onboarding.apply'
  | 'member.apply'
  | 'member.review'
  | 'member.admin'
  | 'portal.admin'
  | 'member.department.create'
  | 'member.provision'
  | 'member.delete';

export type AuditPayload = {
  actor_email?: string | null;
  actor_external_id?: string | null;
  octafuse_user_id?: string | null;
  target?: string | null;
  result?: string | null;
  /** 补充说明（如腾讯云原始错误码）；同样经过脱敏与截断 */
  detail?: string | null;
  ip?: string | null;
  ua?: string | null;
};

export type AuditSink = (line: string) => void;

const KEY_PATTERN = /sk-[A-Za-z0-9_-]{6,}/g;

function configuredSecrets(): string[] {
  const envSecrets: string[] = [];
  try {
    const cfg = getConfig();
    envSecrets.push(
      cfg.portal.localAdmin.password,
      cfg.tencentCloud.secretKey,
      cfg.auth.sessionSecret,
      cfg.auth.oauth2.clientSecret,
      cfg.auth.wecom.secret
    );
  } catch {
    // 配置不可用时只依赖运行期密钥：脱敏函数不能因此抛错
  }

  // 配置表里的敏感值（腾讯云 AK/SK 等）由 overlay 解密后登记，这里一并抹掉
  return [...envSecrets, ...runtimeSecrets()].filter(
    (value): value is string => typeof value === 'string' && value.length >= 6
  );
}

/** 抹掉 Key 明文与配置里的高价值凭证。 */
export function maskSecrets(text: string): string {
  let output = text.replace(KEY_PATTERN, 'sk-***');
  for (const secret of configuredSecrets()) {
    output = output.split(secret).join('***');
  }
  return output;
}

function clean(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // 先脱敏再截断：否则出现在 512 字符之后的凭证会绕过 maskSecrets
  return maskSecrets(String(value)).slice(0, 512);
}

/** 取真实客户端 IP：x-forwarded-for 首个值，取不到就 null（不抛错） */
export function clientIp(headers: Headers): string | null {
  // 与 middleware 的限流共用同一实现，避免两处规则漂移
  return clientIpFromHeaders(headers, '') || null;
}

export function buildAuditRecord(
  event: AuditEvent,
  payload: AuditPayload = {},
  now: Date = new Date()
): Record<string, string | null> {
  return {
    ts: now.toISOString(),
    event,
    actor_email: clean(payload.actor_email),
    actor_external_id: clean(payload.actor_external_id),
    octafuse_user_id: clean(payload.octafuse_user_id),
    target: clean(payload.target),
    result: clean(payload.result),
    detail: clean(payload.detail),
    ip: clean(payload.ip),
    ua: clean(payload.ua),
  };
}

export function audit(
  event: AuditEvent,
  payload: AuditPayload = {},
  sink: AuditSink = (line) => process.stdout.write(`${line}\n`)
): void {
  try {
    sink(JSON.stringify(buildAuditRecord(event, payload)));
  } catch {
    // 审计失败不能影响业务：磁盘满 / stdout 关闭都只丢一条日志
  }
}
