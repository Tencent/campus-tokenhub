# `@octafuse/admin`

**管理控制台**：管理 API Keys、Providers、Models、Routes、Agent Tools、三账本计费、日志、审计与分析。Next.js 16（API）+ Vite SPA（UI）+ **自定义 Node 入口**；与 Proxy **共用同一数据库**（Postgres 或 MySQL）。2.0 中一个 Provider 维护一把上游 Key，Routes 页面按 Request Surface → Route Pool → Upstream Target 展示和配置路由。

## 职责

- **做**：管理 UI；`app/api/admin/[...path]/route.ts` 鉴权后转发到内部 Hono（路径约定见 [docs/developers/api/admin.md](../../docs/developers/api/admin.md)）。
- **不做**：各产品自有门户、插件市场等。

## 环境

- **`ADMIN_USERNAME` / `ADMIN_PASSWORD`**：应急账密，默认不配置；账密登录由 `ADMIN_PASSWORD_LOGIN` 控制，默认关闭（403）。人类正常登录走门户 SSO（`portal_session`），外部系统调 `/api/admin/*` 用后台签发的集成密钥 `Authorization: Bearer <ADMIN_API_KEY>`。
- **数据库**：根 `.env` 的 **`DATABASE_URL`** + **`DATABASE_DRIVER`**（Node；Postgres / MySQL）；须与 Proxy 指向同一逻辑库。
- **`ADMIN_UI_PUBLIC_PATH`**：公网前缀（线上 `/tokenhub/admin`）。只影响前端构建（资源路径、Router basename、浏览器请求），Node 始终以根路径提供服务，前缀由 nginx 剥离。**构建期生效**。

外部自动化：在后台创建具名、最小权限的 Admin API Key，然后使用 `GATEWAY_MASTER_URL` + `Authorization: Bearer <ADMIN_API_KEY>`。

## 命令

```bash
npm run build:ui           # 首次或改 UI 后产出 ui-dist（含 ui-version.json）
npm run dev:admin          # 根目录：Node 入口 :8789（Next API + Vite 产物）
npm run dev:admin:node     # 同上，先加载根 .env（Postgres / MySQL）
npm run build:docker       # 生产：UI + 正常 .next + Node bundle
```

管理台只以 Docker/Node 交付：`build:cf` / `preview` / `deploy` 会直接失败并提示上面的替代命令（Cloudflare/OpenNext 不服务 `/assets/**` 与 `/ui-version.json`）。

单包开发：`cd packages/admin` 后 `npm run dev`（默认 `:3000`；无数据库时管理 API 会失败，仅适合改 Next API）。完整联调请在根目录使用 `npm run dev:admin`（`:8789`，根路径 API）或 `npm run dev:admin:node`（`:8789` + 根 `.env` 的 Postgres / MySQL）。

文档：[docs/README.md](../../docs/README.md) · [route-topology.md](../../docs/developers/architecture/route-topology.md) · [admin API](../../docs/developers/api/admin.md) · [AGENTS.md](./AGENTS.md)

