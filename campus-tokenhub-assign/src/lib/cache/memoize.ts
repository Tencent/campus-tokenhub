/** 极简进程内缓存：只服务「目录 60s」「健康检查 5s」这类可容忍过期的读。 */

export type Memoized<T> = {
  (): Promise<T>;
  /** 读当前缓存（不触发刷新） */
  peek(): { value: T; at: number } | null;
  clear(): void;
};

export function memoizeWithTTL<T>(loader: () => Promise<T>, ttlMs: number): Memoized<T> {
  let cached: { value: T; at: number } | null = null;
  let inflight: Promise<T> | null = null;

  const load = async (): Promise<T> => {
    if (cached && Date.now() - cached.at < ttlMs) return cached.value;
    if (inflight) return inflight;
    inflight = loader()
      .then((value) => {
        cached = { value, at: Date.now() };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };

  const memoized = load as Memoized<T>;
  memoized.peek = () => cached;
  memoized.clear = () => {
    cached = null;
    inflight = null;
  };
  return memoized;
}
