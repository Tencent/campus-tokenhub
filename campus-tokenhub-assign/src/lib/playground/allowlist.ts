/**
 * 调试台的模型可用性门禁。
 *
 * 上游 402（未开通后付费）会被网关当成 auth 失败，把**整个供应商**熔断 5 分钟，
 * 一个人点了未开通的模型，全班所有模型一起 429。所以：
 * - 环境变量白名单外的模型不进选择器
 * - 本次会话里被 402 点名过的模型，后续直接过滤掉
 */

export function parseAllowlist(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 白名单为空表示「不限」，与配置语义一致。 */
export function isModelAllowed(modelId: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  return allowlist.includes(modelId);
}

export function filterByAllowlist<T extends { id: string }>(models: T[], allowlist: string[]): T[] {
  if (allowlist.length === 0) return models;
  return models.filter((model) => isModelAllowed(model.id, allowlist));
}

export function excludeStatus<T extends { id: string; status?: string }>(models: T[]): T[] {
  return models.filter((model) => model.status !== 'discontinued');
}

// ---- 402 之后本地记住（浏览器会话内） ----

const blocked = new Set<string>();

export function markBlocked(modelId: string): void {
  blocked.add(modelId);
}

export function isBlocked(modelId: string): boolean {
  return blocked.has(modelId);
}

export function getBlocked(): string[] {
  return [...blocked];
}

export function clearBlocked(): void {
  blocked.clear();
}
