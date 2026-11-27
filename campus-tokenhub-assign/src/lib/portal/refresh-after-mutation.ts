/** 写入成功后先失效缓存；后续读取失败也不能继续复用写入前的页面快照。 */
export async function refreshAfterMutation(
  invalidate: () => void,
  refresh: () => Promise<unknown>
): Promise<{ refreshed: true } | { refreshed: false; error: string }> {
  invalidate();
  try {
    await refresh();
    return { refreshed: true };
  } catch (cause) {
    return { refreshed: false, error: cause instanceof Error ? cause.message : '读取密钥失败' };
  }
}
