# campus-tokenhub-member（成员自购站）

老师用学校账号登录，自助申请**腾讯云集团成员账号**；管理员审核通过后，服务端调用腾讯云
`organization` 接口建号、分配到部门，把结果写回申请单。

Next.js 15（App Router）+ TypeScript + Tailwind + PostgreSQL。

> **第一次部署？** 把仓库交给 AI，说一句「按 docs/QUICKSTART.md 帮我完成本地部署和调试」。该文件是给 AI 的执行指引，端口与排障参考 [`docs/RUNBOOK-local.md`](docs/RUNBOOK-local.md)。
>
> 完整操作手册（部署 / 使用 / 运维 / 二次开发，含腾讯云组织接口）：[`docs/campus-tokenhub-member-使用教程.md`](docs/campus-tokenhub-member-使用教程.md)

## 与统一采买站的关系

两份代码是**独立部署单元**，不共享进程与网络调用，只共享一个 Postgres 里的 `portal_shared`：

| | 统一采买站（`campus-tokenhub-assign`） | 成员自购站（本仓库） |
| --- | --- | --- |
| 做什么 | 学生领 API Key、看模型与用量、调试 | 老师申请腾讯云集团成员账号 |
| 依赖 octafuse 网关 | 是 | **否**（零依赖，可独立部署） |
| 依赖腾讯云 organization 接口 | 否 | 是 |
| 会话 Cookie | `portal_session` | 同名同密钥，两站互认 |

两站同时部署时共用同一个会话：任一站登录，另一站免登；任一站登出，两站同时失效。
前提是两侧 `SESSION_SECRET` 相同、`PORTAL_COOKIE_PATH` 相同（见「部署」）。

## 数据落在哪

与网关共用同一个 Postgres，但**分三个 schema**，互不侵入：

| schema | 归属 | 表 |
| --- | --- | --- |
| `portal_shared` | 两站共用 | `admins`、`app_config`、`login_config`、`settings`、`session_revocations`、`config_audit` |
| `portal_assign` | 统一采买站 | `activity_configs` |
| `portal_member` | **本仓库** | `member_applications` |

共享层只有一份：管理员名单在任一站增删，另一站立即生效。

## 管理员判定

两种来源任一命中即为全局管理员，判定顺序：

1. 引导期账号密码登录的本地身份（`local:<username>`，凭据只来自 env）；
2. 共享层 `portal_shared.admins` 名单命中。

名单为空时，**首个合法登录者自动认领**为管理员（写入上面的名单表；
`ADMIN_EMAILS` 邮箱白名单已移除，管理员只认表）。

名单为空且首个登录者身份不是 `school_id:user_id` 格式时，用兜底命令指定：

```bash
npm run bootstrap-admin -- "school_001:100234567"
```

（直连库写 `portal_shared.admins`，幂等，不依赖 Web 会话。）

## 部署

### 单站（只部署成员站）

```bash
cp .env.example .env     # 填 POSTGRES_PASSWORD / SESSION_SECRET
docker compose up -d
```

只起 `postgres` + `portal` + `portal-seed` 三个服务，**没有网关、没有 nginx**。
默认宿主端口 `3200`（`PORTAL_HOST_PORT` 可覆盖）。

### 双站（与统一采买站同域共存）

用统一采买站仓库的 `docker-compose.dual.yml`：一个 Postgres、一套 nginx、两个前缀。

两站共享会话的关键三项（必须一致）：

```bash
SESSION_SECRET=<32+ 字符，两站相同>
PORTAL_COOKIE_PATH=/tokenhub        # 两站的公共前缀，不能填各自的 basePath
PORTAL_COOKIE_DOMAIN=               # 留空 = host-only；跨子域才设父域
```

`PORTAL_BASE_PATH` 是**构建期**配置（Next 的 basePath 编译进产物），改完必须重建镜像。

## 关键配置

| 变量 | 说明 |
| --- | --- |
| `PORTAL_DATABASE_URL` | 门户库连接串（与网关同库、不同 schema） |
| `SESSION_SECRET` | 会话签名密钥，**两站必须相同**才能互认 |
| `SESSION_TTL_HOURS` | 会话有效期，默认 8 小时 |
| `PORTAL_COOKIE_PATH` / `PORTAL_COOKIE_DOMAIN` | Cookie 作用域，见上 |
| `COOKIE_SECURE` | 上 TLS 后必须 `true`，否则浏览器丢弃 Cookie |
| `TENCENTCLOUD_SECRET_ID` / `_SECRET_KEY` | 腾讯云 CAM 凭据（要 organization 读写权限） |
| `MEMBER_ACCOUNT_PROVIDER` | `tencent`（真实）或 `mock`（**仅本地/测试**，生产会拒绝启动） |

## 旧数据迁移

从旧 `portal` schema 搬数据：

```bash
# 先启动一次，让应用建表
psql "$PORTAL_DATABASE_URL" -f deploy/migrate/020-shared.sql   # 共享层，两侧脚本相同
psql "$PORTAL_DATABASE_URL" -f deploy/migrate/021-own.sql      # 本侧：member_applications
```

详见 `deploy/migrate/README.md`（幂等标记、加密列处理、核对 SQL）。

## 本地开发

```bash
npm ci
npm run env:local      # 生成本地 .env.local 与 compose 覆盖（不入库）
npm run dev
```

```bash
npm run typecheck
npm test               # vitest
npm run check:isolation  # 门禁：src/ 中不得出现跨侧引用
```

`check:isolation` 会拦住把网关代码、成员代码混进来的改动——两侧拆开就是为了不再互相绑死。
