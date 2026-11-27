/**
 * 「接口地址未配置」提示条。
 *
 * `NEXT_PUBLIC_PROXY_BASE` 决定指南、调试台与模型详情页里展示的接口地址。
 * 留空时页面会渲染成 `/v1/chat/completions` 这种相对地址：不报错，但复制到终端
 * 或客户端里跑不通。与其让用户自己发现，不如在页面上直接说明缺什么、该填什么。
 *
 * 服务端组件，无客户端依赖；`proxyBase` 有值时整块不渲染。
 */
export function ProxyBaseNotice({ proxyBase }: { proxyBase: string }) {
  if (proxyBase.trim()) return null;

  return (
    <div
      role="alert"
      className="rounded-card border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800"
    >
      未配置接口地址（<code className="font-mono">NEXT_PUBLIC_PROXY_BASE</code>
      ），下方的接口地址与示例代码不完整，复制到终端会请求相对路径。请联系部署人员补成浏览器可达的网关地址（如{' '}
      <code className="font-mono">https://&lt;域名&gt;/tokenhub</code>）。
    </div>
  );
}
