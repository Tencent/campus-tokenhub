/**
 * 页面访问路径的规范化与去重判定（纯函数，便于单测）。
 *
 * 只保留站内相对路径：查询串、hash、外站地址、控制字符一律剔除或拒绝。
 * 页面访问记录里存 query 会把一次性 token、搜索词等敏感内容带进数据库，
 * 也会让同一页面的行数被参数变化放大，所以这里直接截断。
 */

/** 路径最大长度：超过就截断，避免把超长 URL 写进索引列 */
export const VISIT_PATH_MAX = 512;

/** 同一路径在该窗口内重复触发只记一次 */
export const VISIT_DEDUPE_WINDOW_MS = 1000;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * 规范化上报路径。
 *
 * @returns 合法的站内路径；非法输入返回 `null`（调用方应拒绝写库）
 */
export function normalizeVisitPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (!value) return null;
  // 必须以单个 `/` 开头：`//evil.com` 是协议相对地址，会被浏览器当成外站
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  if (CONTROL_CHARS.test(value)) return null;

  // 先砍 hash 再砍 query：`/a#x?y` 的 `?y` 属于 hash 内容，不应被当成查询串
  const withoutHash = value.split('#', 1)[0] ?? '';
  const path = withoutHash.split('?', 1)[0] ?? '';

  if (!path.startsWith('/')) return null;
  if (path.startsWith('//') || path.startsWith('/\\')) return null;
  if (CONTROL_CHARS.test(path)) return null;

  return path.slice(0, VISIT_PATH_MAX);
}

/**
 * 是否应跳过本次上报。
 *
 * 判定条件：与上次路径相同，且距上次不足窗口。首次访问（`lastPath === null`）永远不跳过。
 */
export function shouldDedupe(
  lastPath: string | null,
  lastAt: number,
  nextPath: string,
  now: number,
  windowMs: number = VISIT_DEDUPE_WINDOW_MS
): boolean {
  if (lastPath === null) return false;
  if (lastPath !== nextPath) return false;
  return now - lastAt < windowMs;
}

/** 上一次上报的状态；`null` 表示本次挂载还没报过 */
export type VisitState = { path: string; at: number } | null;

/** 一次路径变化的决策结果 */
export type VisitPlan = { report: false } | { report: true; path: string; at: number };

/**
 * 决定「这次路径变化要不要上报」。
 *
 * 从 `VisitTracker` 的 effect 里抽出来，是因为 effect 在 SSR / node 测试环境里根本不会执行，
 * 去重失效、重复上报这类回归无法被组件测试捕获。这里只做纯判断，不发请求。
 */
export function planVisit(last: VisitState, rawPathname: unknown, now: number): VisitPlan {
  const path = normalizeVisitPath(rawPathname);
  if (!path) return { report: false };
  if (last && shouldDedupe(last.path, last.at, path, now)) return { report: false };
  return { report: true, path, at: now };
}
