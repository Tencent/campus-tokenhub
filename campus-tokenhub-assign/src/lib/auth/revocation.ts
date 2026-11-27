/**
 * 会话吊销名单。
 *
 * 会话是无状态 JWT（登出只清浏览器 Cookie），一旦 Cookie 被复制走，原持有人登出也无法止损。
 * 这里按用户存一个「吊销时间点」：签发时间早于该点的 token 一律失效，
 * 相当于「登出 = 该用户所有设备上的会话全部作废」。
 *
 * 实现取舍：
 * - 不放 JWT 黑名单（逐 token 存），只存每个用户一个时间点，表很小；
 * - 读取带 60 秒进程内缓存，避免每个请求都打库；
 * - 数据库不可用时**按未吊销处理**并告警：吊销是安全增强，不能因为库抖动把全校挡在门外。
 */

import { getDb, isPortalDbConfigured } from '@/lib/db/portal-db';
import { SESSION_REVOCATIONS_TABLE } from '@/lib/config/tables';

const CACHE_TTL_MS = 60_000;
/**
 * 读取失败后的冷却时间。
 *
 * 失败也缓存，但只缓存 5 秒：库挂了的时候每个请求都会去撞一次 SQL，
 * 连超时算进去足以把连接池和请求预算吃满（等于安全增强反过来放大故障）。
 * 5 秒足够把重试压到每秒一次以内，又不至于让刚登出的会话在别的副本上长时间可用。
 */
const FAILURE_TTL_MS = 5_000;
const cache = new Map<string, { value: number; expiresAt: number }>();
let warned = false;

/** 该用户的会话在什么时间点之前全部失效；没有记录返回 null。 */
export async function readSessionRevokedBefore(sub: string): Promise<number | null> {
  if (!sub || !isPortalDbConfigured()) return null;

  const hit = cache.get(sub);
  if (hit && hit.expiresAt > Date.now()) return hit.value > 0 ? hit.value : null;

  try {
    const { rows } = await getDb().query<{ revokedBefore: Date | string | null }>(
      `SELECT revoked_before AS "revokedBefore" FROM ${SESSION_REVOCATIONS_TABLE} WHERE sub = $1`,
      [sub]
    );
    const raw = rows[0]?.revokedBefore;
    const value = raw ? new Date(raw).getTime() : 0;
    cache.set(sub, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value > 0 ? value : null;
  } catch (error) {
    // 仍按未吊销处理（可用性优先，见文件头），但要压住重试频率
    cache.set(sub, { value: 0, expiresAt: Date.now() + FAILURE_TTL_MS });
    if (!warned) {
      warned = true;
      console.warn(
        '[auth] 会话吊销表读取失败，本次按未吊销处理（5 秒内不再重试）',
        error instanceof Error ? error.message : String(error)
      );
    }
    return null;
  }
}

/** 登出：吊销该用户当前时间点之前签发的所有会话。 */
export async function revokeSessionsFor(sub: string, at: number = Date.now()): Promise<void> {
  if (!sub) return;
  // 先写缓存：即使数据库写失败，本进程也立即生效
  cache.set(sub, { value: at, expiresAt: Date.now() + CACHE_TTL_MS });
  if (!isPortalDbConfigured()) return;

  try {
    await getDb().query(
      `INSERT INTO ${SESSION_REVOCATIONS_TABLE} (sub, revoked_before)
       VALUES ($1, to_timestamp($2 / 1000.0))
       ON CONFLICT (sub) DO UPDATE
         SET revoked_before = GREATEST(${SESSION_REVOCATIONS_TABLE}.revoked_before, EXCLUDED.revoked_before),
             updated_at = now()`,
      [sub, at]
    );
  } catch (error) {
    console.warn(
      '[auth] 会话吊销写库失败（本进程仍生效）',
      error instanceof Error ? error.message : String(error)
    );
  }
}

/** 测试用：清缓存 */
export function resetSessionRevocationCache(): void {
  cache.clear();
  warned = false;
}

/**
 * 校验一条已验签的会话是否已被登出吊销。
 *
 * 放在 `requireSession` / `requireCurrentSession` 里调用，而不是塞进 `verifySession`：
 * middleware 也会 import session.ts，把 pg 带进去会让 middleware 打包失败。
 */
export async function isSessionRevoked(session: { sub: string; iat: number }): Promise<boolean> {
  const revokedBefore = await readSessionRevokedBefore(session.sub);
  if (!revokedBefore) return false;
  // iat 单位是秒；留 1 秒余量，避免同一秒内「登出再登录」的新会话被误杀
  return session.iat * 1000 + 1000 < revokedBefore;
}
