import type { NextConfig } from 'next';

/**
 * 门户部署路径前缀。
 *
 * 线上门户挂在 `https://zhiqi.woa.com/tokenhub/portal`（与网关同域）。
 * Next 会把 `_next` 静态资源、页面跳转、RSC 请求都写成**根绝对路径**，
 * 只靠反代剥前缀会让浏览器去域名根取 `/_next/...`（共享域名下还会撞别的服务），
 * 所以门户必须自带 basePath，反代对门户**原样透传**前缀。
 * 该值在**构建期**生效，改完必须重建镜像。
 */
const basePath = (process.env.PORTAL_BASE_PATH ?? '').trim().replace(/\/+$/, '');

const nextConfig: NextConfig = {
  ...(basePath ? { basePath } : {}),
  // basePath 只在构建期由 Next 内部使用，客户端组件拿不到；
  // 它们拼 `/api/...` 时要用这个公开变量，所以显式注入一份。
  env: { NEXT_PUBLIC_PORTAL_BASE_PATH: basePath },
  output: 'standalone',
  // pg 是 CJS + 可选原生依赖（pg-native），交给 Node 直接 require，不参与打包
  serverExternalPackages: ['pg'],
  // 共享活动包以 TS 源码形式通过 file: 依赖引入，必须让 Next 转译它；
  // 不加这条，node_modules 里的 .tsx/.ts 不会被编译，构建直接失败。
  transpilePackages: ['@campus/portal-activity'],
  // 不指定这个，Next 会往上找到 /Users/lxhao/package-lock.json 当 workspace root，
  // 于是 standalone 产物被塞进 .next/standalone/WorkBuddy/.../，Dockerfile 里的
  // `node server.js` 就找不到入口。
  outputFileTracingRoot: process.cwd(),
  // root 保持门户目录本身：共享活动包由 scripts/sync-activity-package.mjs 复制成
  // node_modules 里的真实目录（不再是越界的符号链接），所以不需要把 root 上提。
  turbopack: { root: process.cwd() },
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 移除了内置 ESLint 集成（`next lint` 已不存在），`eslint.ignoreDuringBuilds`
  // 不再是合法字段，留着会让 `next build` 的类型检查直接报错。
  // 代码规范检查改为独立执行：`npm run lint`。
  // 开发态左下角的 Next 悬浮指示器（那个圆形 N）会压住门户侧边栏底部提示，直接关掉。
  // 仅影响 `next dev`，不影响生产构建。
  devIndicators: false,
  experimental: {
    // 门户页面全部 force-dynamic，默认 staleTimes.dynamic = 0，来回切 tab 每次都要
    // 重新走服务端（dev 下实测 300~500ms、首次编译路由可到 2s+）。这里给客户端
    // RSC 缓存留窗口，重复进入已看过的页面直接复用，不再等一整轮服务端渲染。
    // 取 120s 的依据：看板数据本身 5 分钟才汇总一次；写操作（创建/吊销密钥、领取额度、
    // 提交申请）成功后都会调用 router.refresh() 绕过该缓存强制取新值。
    staleTimes: {
      dynamic: 120,
      // FULL 预取也走 static 窗口，不能沿用更长的缓存敏感的用户数据。
      static: 120,
    },
  },
};

export default nextConfig;
