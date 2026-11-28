# AGENTS.md — `@octafuse/admin`

仓库级约定见 [../../AGENTS.md](../../AGENTS.md)。本文件只写管理后台这个包。

## Overview

Gateway **Admin** console: API keys, providers, models, routes, `system_config`, request logs, budget audit, analytics. Delivery stack: **Next.js 16（常规生产构建）+ Vite SPA + 自定义 Node 入口**，单镜像、单端口 `:8789`。

This package lives in the **`octafuse`** monorepo. 管理台只以 **Docker / Node** 交付：Node 入口同时提供 SPA、`/api/*` 与实时通道，数据库走 `DATABASE_URL` + `@octafuse/core`（与 Proxy Node 同一套规则）。Public admin HTTP APIs are **`/api/admin/*`** (internal Hono uses **`/admin/*`**). The **`@octafuse/proxy` Worker does not expose admin routes**.

仓库里仍留有 Cloudflare / OpenNext（`wrangler.jsonc`、D1）配置，那是历史入口，**不在管理台交付路径上**：`build:cf` / `preview` / `deploy` 现在会明确失败并打印 Node 替代命令（`scripts/node-only-command.mjs`），不要据此判断管理台可用性。

**Out of scope for this app**: desktop client version feeds, plugin catalogs, user-growth analytics in a separate billing/portal product—the Admin here is **gateway operations only**.

## Commands

**Prefer repo root** (reads root `.env` / `.env.local`, same convention as Proxy Node+PG):

```bash
npm run dev:admin        # = dev:admin:node：Next + Postgres + playground WS :8789
```

Inside **`packages/admin`** (needs `.env` here or `ln -s ../../.env .env`):

```bash
npm run dev                # :3000，next dev（Vite SPA 入口与 node-server 不在此模式）
npm run dev:node           # :8789 + Postgres + playground realtime WS
npm run build:docker       # ui-dist + 正常 .next + node-server-dist（镜像构建入口）
npm run verify:production  # 构建（或 ADMIN_VERIFY_IMAGE 复用）镜像，起临时容器验证生产 Node 入口
npm run typecheck          # tsc -p tsconfig.json --noEmit
npm run lint               # eslint .
npm run test:unit          # tsx --test（Node 侧单测清单）
npm run test:ui            # vitest run（DOM/TSX）
```

调试 admin API 用 `npm run dev:node`（Postgres）。不要用 Proxy Worker 代替管理台。

Cloudflare 相关入口已收敛为明确的“不支持”报错（不再产出 `worker.js`）：

```bash
npm run build:cf    # exit 1 + Node 替代命令
npm run preview     # exit 1 + Node 替代命令
npm run deploy      # exit 1 + Node 替代命令
npm run cf-typegen  # 仅历史类型生成；Node 交付链路不依赖，fresh clone 不需要它
```

After changing `@octafuse/core` types used by Admin (adapters, route topology, mappings), run **`npm run typecheck:admin`** (or `npm run typecheck -w @octafuse/admin`) **before** opening a PR. Docker `next build` typechecks imported core source; the `verify` job does not.

**Self-hosted Postgres + containers**: **`Dockerfile.admin`** multi-stage build runs **`npm run build:docker`**（Vite `ui-dist` + 正常 `.next` + `scripts/build-node-server.mjs` 产物，**不**生成 `.next/standalone`，**不**跑 `wrangler types`，与 CI 中 `npm ci --ignore-scripts` 兼容；类型兜底见 **`types/cloudflare-env-shim.d.ts`**），默认 **`CMD`**: `node packages/admin/node-server-dist/node-server.mjs`，`:8789`，应用进程 only。Schema changes use the **`Dockerfile.migrate`** image (`docker compose --profile migrate run --rm migrate`). Inject **`DATABASE_URL`**, **`DATABASE_DRIVER`** (default `postgres` if omitted), and **`ADMIN_USERNAME` / `ADMIN_PASSWORD`**, same database as **`Dockerfile.proxy`**. Public prefix goes in the build arg **`ADMIN_UI_PUBLIC_PATH`** (front-end only; nginx strips it). See `../../docs/operators/deployment/docker.md`.

## Architecture

| Path | Role |
|------|------|
| `app/api/admin/[...path]/route.ts` | Database Session or named Admin API Key auth; rewrite URL → Hono |
| `lib/admin-app.ts` | Hono: `/admin/keys`, `/admin/providers`, … |
| `lib/routes/admin/*` | Admin HTTP handlers |
| `lib/services/admin/*` | Admin services (use `@octafuse/core`) |
| `lib/admin-ui-route-manifest.ts` + `lib/admin-ui-dispatch.ts` | 唯一纯数据路由清单；Node 侧页面匹配与静态分发 |
| `ui/*` | SPA（Vite）：`routes.tsx` 按 route ID 绑定 lazy 模块，`public-path.ts` / `prefetch.ts` 管前缀与意图预取 |
| `runtime/node-server.ts` | Node 入口：Upgrade → 既有实时处理器，`/api/*` → Next，页面/静态 → dispatch |
| `app/**/page.tsx` | 历史 Next 页面包装层，Node 不入站渲染；线上面向浏览器的路由以 `lib/admin-ui-route-manifest.ts` 为准 |
| `lib/provider-import-presets.json` + `lib/provider-import-preset.ts` | Providers 静态导入模板（预填 endpoint；占位 API Key） |
| `lib/routes/admin/playground.ts` | Playground: single-route upstream test (no `api_key_request_logs`, no billing, no failover) |

## Environment (Docker / Node)

| Variable | Purpose |
|----------|---------|
| `ADMIN_USERNAME` | Emergency password-login username; disabled by default (container env). |
| `ADMIN_PASSWORD` | Emergency password-login password; **do not** commit. Effective only together with `ADMIN_PASSWORD_LOGIN=on`. |
| `ADMIN_UI_PUBLIC_PATH` | Public prefix for the SPA (e.g. `/tokenhub/admin`). **Build-time, front-end only**; the Node entry always serves root paths and nginx strips the prefix. |
| `ADMIN_COOKIE_SECURE` | Optional hardening. Unset by default (**no** `Secure` on `admin_session`, so plain HTTP works). Set `1`/`true`/`yes`/`on` only if Admin is already served over HTTPS and you want the browser to send the session cookie on HTTPS only — see [`docs/operators/deployment/docker.md`](../../docs/operators/deployment/docker.md) §7.3. |
| `DATABASE_URL` | **Node / self-hosted Postgres** (same name as `@octafuse/proxy` Node). |
| `DATABASE_DRIVER` | **Node / self-hosted**: same semantics as Proxy (`@octafuse/core`); omit → `postgres`; invalid or inconsistent with `DATABASE_URL` → **error** |

Downstream portals: set **`GATEWAY_MASTER_URL`** to this app’s origin, create a named least-privilege key in **Integration Keys**, then call **`/api/admin/...`** with `Authorization: Bearer <ADMIN_API_KEY>`.

## Monorepo build notes

- `next.config.mjs` keeps `outputFileTracingRoot` and `turbopack.root` at the **`octafuse` root** so hoisted `next` resolves. No `basePath`/`assetPrefix` and no `output: 'standalone'`.
- `npm run build:docker` produces `ui-dist` (Vite), a normal `.next` and `node-server-dist/node-server.mjs`; the production image ships full `node_modules` and starts that bundle.

## Response shape

Same contract as gateway admin APIs: `{ success, data?, message?, ... }`.

## Internationalization (i18n)

Admin UI uses **[next-intl](https://next-intl.dev)** in **without-i18n-routing** mode (no `middleware.ts`, URLs stay `/dashboard`, `/gateway/*`).

| Path | Role |
|------|------|
| `lib/i18n.ts` | Locales (`en`, `zh`, `ja`, `ko`), cookie-based `getRequestConfig` |
| `lib/locale.ts` | `LOCALE_COOKIE` (`NEXT_LOCALE`), `resolveLocale()` |
| `app/api/locale/route.ts` | `POST` sets locale cookie |
| `components/layout/LocaleSwitcher.tsx` | Language dropdown (sidebar + login) |
| `messages/en.json` | English copy |
| `messages/zh.json` | 简体中文 copy |
| `messages/ja.json` | 日本語 copy |
| `messages/ko.json` | 한국어 copy |

**Conventions for new UI copy:**

- Add strings to all files under `messages/` with identical key structure, using `messages/en.json` as the structural baseline (`sidebar`, `providers`, `config`, `common`, …).
- Client components: `useTranslations('namespace')`; server layout/metadata: `getTranslations` from `next-intl/server`.
- Do **not** hardcode user-visible English in JSX or `lib/*` UI helpers — pass `t()` or a labels object (see `lib/pricing-ui.ts` `PricingLabels`, `getBusinessTimezoneOptions`, `getBillingCurrencyOptions`).
- **Out of scope**: Hono/service error messages (display `data.message` as-is), JSON presets (`provider-import-presets.json`, `model-presets/*`), provider/model IDs.

## Docs

- [docs/README.md](../../docs/README.md)
- [docs/developers/api/admin.md](../../docs/developers/api/admin.md)
- [docs/developers/architecture/admin-layered.md](../../docs/developers/architecture/admin-layered.md)
