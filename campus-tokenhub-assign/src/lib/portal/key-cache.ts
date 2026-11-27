/**
 * 「当前有效 Key」的内存缓存，供调试台与模型详情共用。
 *
 * 边界（与 /api/portal/key 的既有设计一致）：
 * - 只存在 JS 模块内存，不写 localStorage / sessionStorage，不进 SSR HTML；
 * - 同一页面会话内复用，避免每次进调试台、每次打开模型详情都重新请求；
 * - 成功结果也有 TTL：别的设备吊销/换了 Key 时本端最多滞后 60 秒；
 * - inflight 去重：dev StrictMode 下 effect 跑两次也只发一个请求；
 * - 失败结果短暂缓存，避免网关抖动时反复打；写操作成功后由调用方 invalidate。
 */

import { appPath } from '@/lib/paths';

export type ActiveKeyResult =
  | { ok: true; key: string }
  | { ok: false; error: string; code?: string };

/** 成功结果的缓存时长：吊销发生在别的设备时，本端最多滞后这么久 */
const SUCCESS_TTL_MS = 60_000;
const FAILURE_TTL_MS = 10_000;

let cached: { result: ActiveKeyResult; at: number } | null = null;
let inflight: Promise<ActiveKeyResult> | null = null;
let generation = 0;

async function fetchActiveKey(): Promise<ActiveKeyResult> {
  try {
    const response = await fetch(appPath('/api/portal/key'), { cache: 'no-store' });
    const body = (await response.json().catch(() => ({}))) as { key?: string; error?: string; code?: string };
    if (response.ok && body.key) return { ok: true, key: body.key };
    return { ok: false, error: body.error ?? '还没有可用的密钥', code: body.code };
  } catch {
    return { ok: false, error: '读取密钥失败，请稍后重试' };
  }
}

export async function loadActiveKey(): Promise<ActiveKeyResult> {
  if (cached) {
    const ttl = cached.result.ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.result;
  }
  if (inflight) return inflight;

  const current = generation;
  inflight = fetchActiveKey()
    .then((result) => {
      // 请求期间发生过 invalidate（例如刚吊销）时，不要把旧结果写回缓存
      if (current === generation) cached = { result, at: Date.now() };
      return result;
    })
    .finally(() => {
      if (current === generation) inflight = null;
    });
  return inflight;
}

/** 强制重新读取（用户点「重新读取」时用） */
export async function reloadActiveKey(): Promise<ActiveKeyResult> {
  invalidateActiveKey();
  return loadActiveKey();
}

/** 创建 / 吊销 / 账号切换后调用，下一次读取会重新请求 */
export function invalidateActiveKey(): void {
  generation += 1;
  cached = null;
  inflight = null;
}
