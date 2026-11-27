/**
 * 运行期密钥的登记处。
 *
 * 日志脱敏（`audit.ts`）需要知道「当前生效的敏感配置值」，但这些值来自配置表、
 * 由 overlay 解密后持有。用一层注册避免 `audit → overlay → store → audit` 的循环依赖：
 * overlay 加载完成后调用 `setRuntimeSecretProvider`，脱敏时反过来问它要。
 *
 * 只保存取值函数，不缓存明文，减少明文在内存里的副本。
 */

export type RuntimeSecretProvider = () => string[];

let provider: RuntimeSecretProvider | null = null;

export function setRuntimeSecretProvider(next: RuntimeSecretProvider | null): void {
  provider = next;
}

export function resetRuntimeSecretProvider(): void {
  provider = null;
}

/** 取当前运行期密钥明文；来源异常时返回空数组（脱敏绝不能因此抛错）。 */
export function runtimeSecrets(): string[] {
  if (!provider) return [];
  try {
    const values = provider();
    return Array.isArray(values) ? values.filter((item) => typeof item === 'string' && item.length >= 6) : [];
  } catch {
    return [];
  }
}
