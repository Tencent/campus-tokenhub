# 修改说明（AGPL-3.0 §5(a)）

本目录是 [OctaFuse Gateway](https://github.com/OctaFuse/octafuse-gateway) 的修改版本，
用于对接学校 AI 模型门户（`campus-tokenhub-assign`）。依 AGPL-3.0 第 5 条 (a) 款，在此显著声明修改事实、修改内容与日期。

- 上游基线：公开仓库 `main` 上的 commit `f802b02dcc9bfc35524028174d13ce44ada4bcf9`（2026-11-20）
- 修改方：campus-tokenhub 项目（Tencent）
- 修改时间：2026-11（逐文件的具体日期见各文件头部的修改声明）
- 许可证：本目录整体仍为 **AGPL-3.0**，不因上游或本仓库其他部分的许可证而改变

## 一、修改声明写在哪里

1. **源码、脚本、配置、迁移**：每个被修改或新增的文件，头部都带一行声明（示例）：

   ```
   /*
    * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
    * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
    */
   ```

   - 日期口径：该文件在本仓库**最后一次实质修改**的提交日期。
   - `2026-11-24` 是网关首次纳入本仓库的日期；在此之前于本项目内部完成的改动没有独立提交历史，统一以该日期标注。

2. **无法写注释的文件**（`*.json`、`*.md`）：不在文件内加声明，逐个列在本文第五节。

3. **全量清单**（带声明头的文件即全部修改/新增的源码类文件，共 211 个）：

   ```bash
   grep -rl "Modified by the campus-tokenhub project" . --exclude=MODIFICATIONS.md | wc -l   # 211
   ```

4. **变更摘要**：见同目录 `CHANGELOG.md`，其中标注「本校定制，与上游差异」的条目为本项目改动。

## 二、与上游的差量（相对上述基线 commit）

| 类型 | 数量 | 说明 |
| --- | --- | --- |
| 内容不同的既有文件 | 149 | 其中 1 个仅有引号/空白风格差异，其余为实质改动 |
| 新增文件 | 87 | 分布见第三节各子系统 |
| 删除文件 | 8 | 见 3.8 节 |

## 三、修改内容

逐条变更记录见同目录 `CHANGELOG.md`，其中标注「本校定制，与上游差异」的条目即本项目的改动。按子系统归纳：

### 3.1 限流与配额

- `api_keys.rate_limit` / `users.rate_limit` 在 `rpm` 之外新增 `tpm` 维度，按 60 秒滚动窗口统计 token 吞吐；429 响应新增 `X-OctaFuse-RateLimit-Dimension` 头标出命中维度（无数据库迁移）
  - `packages/proxy/src/services/token-rate-limit.ts`、`packages/core/src/lib/api-key-rate-limit.ts`、`packages/proxy/src/middleware/auth.ts`
- `POST /admin/users` 支持在建号时写入用户级限流，命中已存在用户时忽略，避免调用方覆盖管理员后续调整
- 管理台 Keys 页与用户详情的编辑界面新增 TPM 输入，列表按已配置维度并列展示

### 3.2 管理与认证（门户集成）

- 管理员复核新增门户名单来源（`portal.member_admins`），判定顺序对齐门户侧 `resolvePortalAdmin`
  - `packages/admin/lib/portal-admin-guard.ts`、`portal-admin-store.ts`
- 管理台登录支持复用门户 SSO 会话（`portal_session`，HS256 验签 + `purpose=portal-session` + `admin=true`），保留 Bearer 管理密钥与账号密码两种方式
  - `packages/admin/lib/portal-session.ts`、`admin-auth-mode.ts`、`admin-auth-state.ts`、`admin-auth-coordinator.ts`、`auth.ts`
- `/api/auth/check` 改为四态返回并恒为 200，`mode` 由运行期 `ADMIN_AUTH_MODE` 控制
- portal 模式下账密登录默认关闭（2026-11-27）：`/api/auth/login` 按 `ADMIN_AUTH_MODE` × `ADMIN_PASSWORD_LOGIN` × 口令强度判定，未显式 `ADMIN_PASSWORD_LOGIN=on` 或口令为公开示例值（`change-me` / `octafuse123` 等）时返回 403 且不签发会话
  - `packages/admin/lib/admin-password-policy.ts`（新增，含单测）、`app/api/auth/login/route.ts`
- 登出在配置 `PORTAL_LOGOUT_URL` 时服务端代理门户登出并透传 `Set-Cookie`
  - `packages/admin/lib/portal-logout.ts`、`app/api/auth/logout/route.ts`
- 管理台登录改为本地限流（`packages/admin/lib/login-rate-limit.ts`），取代上游的 `admin-login-guard` 与 `LoginLockoutDialog`

### 3.3 请求正文采集与回看

- 代理侧采集请求/响应正文并按上限截断：`packages/proxy/src/services/content-capture/{extract,accumulate,limits}.ts`、`services/accounting/content-sink.ts`
- 落库与查询：`packages/core/src/db/postgres/request-content.impl.ts`、迁移 `0037_request_content.sql`、`0038_request_content_function_fix.sql`
- 管理台回看面板与保留期维护：`packages/admin/lib/request-content/*`、`app/gateway/request-logs/request-content-section.tsx`

### 3.4 管理台 SPA（Vite + react-router）

上游管理台为 Next.js 页面直出；本副本增加一套 SPA 运行时，页面由 `packages/admin/ui/*` 挂载，Next 侧保留路由与 API：

- `packages/admin/ui/*`（`App.tsx`、`main.tsx`、`routes.tsx`、`link*.tsx`、`navigation*.ts`、`prefetch.ts`、`auth-coordinator.ts`、`sso-redirect.ts` 等 24 个文件）
- 配套：`lib/admin-ui-dispatch.ts`、`admin-ui-route-manifest.ts`、`admin-ui-version.ts`、`admin-build-id.ts`、`admin-public-path.ts`、`admin-browser-path.ts`、`admin-root-api.ts`
- 构建配置：`packages/admin/vite.config.ts`、`vitest.config.ts`、`tsconfig.ui.json`、`packages/admin/ui/index.html`

### 3.5 门户用量聚合

- 新增按「用户 × 日 × 模型」的预聚合表与看板查询，避免按时间窗扫明细
  - 迁移 `packages/core/migrations-postgres/0036_portal_usage_daily.sql`
  - `packages/admin/lib/portal-usage/{service,routes,worker}.ts`

### 3.6 模型目录与界面

- 模型目录按门户侧预置清单调整（腾讯云 TokenHub / 阿里云百炼 / 火山方舟三家，含价格与档位）
- 模型列表的类型筛选改为页签（`app/gateway/models/components/model-kind-tabs.tsx`），计数随状态与厂商筛选实时更新
- 模拟器支持并列查看输入 JSON 与发往网关的请求，并可查看脱敏上游快照
- 请求日志与调试台可查看生效的供应商、路由配置字段与请求头来源

### 3.7 构建与部署

- Dockerfile / compose 的本地与生产构建差异（镜像内构建 Vite UI、`.dockerignore` 排除本地软链）
- `docker/compose/node-mysql.yml`、`docker/compose/node-pg.yml`、`docker/compose/quickstart.yml`、`Dockerfile.admin`、`docker/entrypoint.app.sh`

### 3.8 删除的上游文件

| 文件 | 处理 |
| --- | --- |
| `packages/admin/lib/admin-login-guard.ts` / `.test.ts` | 由 `lib/login-rate-limit.ts` 取代 |
| `packages/admin/lib/admin-node-login-peer.ts` / `.test.ts` | 门户 SSO 改造后不再需要 |
| `packages/admin/components/layout/LoginLockoutDialog.tsx` | 随 `admin-login-guard` 一并移除 |
| `packages/admin/app/api/auth/login/route.test.ts` | 登录实现变更后重写 |
| `packages/admin/scripts/link-standalone-next.mjs`、`verify-standalone-boot.mjs` | 由 `scripts/verify-production.mjs`、`node-only-command.mjs` 取代 |

## 四、许可证与分发

- 保留上游全部许可证与版权声明，`LICENSE` 文件未作修改（AGPL-3.0 全文）
- 本目录可独立构建运行；上游的部署方式、文档与 API 契约仍然适用
- 若需基于本副本二次开发，请遵循 AGPL-3.0，而非本仓库根目录的 MIT
- 对外提供基于本网关的网络服务时，依 AGPL-3.0 第 13 条须向服务使用者提供对应源码（即本目录全部内容）

## 五、无法携带注释的文件（25 个）

以下文件同样被修改或新增，但格式不支持注释，以此清单代替文件内声明：

**JSON（11）**

```
package.json
package-lock.json
packages/admin/package.json
packages/admin/tsconfig.json
packages/admin/tsconfig.ui.json
packages/admin/messages/en.json
packages/admin/messages/ja.json
packages/admin/messages/ko.json
packages/admin/messages/zh.json
packages/core/package.json
packages/proxy/package.json
```

**文档（14）**

```
AGENTS.md
CHANGELOG.md
MODIFICATIONS.md
packages/admin/AGENTS.md
packages/admin/README.md
docs/developers/api/admin.md
docs/developers/api/user.md
docs/developers/architecture/proxy-request-lifecycle.md
docs/developers/architecture/runtime-data.md
docs/developers/local-development.md
docs/developers/reference/streaming-billing.md
docs/operators/deployment/cloudflare.md
docs/operators/deployment/docker.md
docs/users/features.md
```
