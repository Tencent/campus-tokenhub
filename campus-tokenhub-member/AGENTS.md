# AGENTS.md

给在这个仓库里工作的 AI 助手。人看的文档见 [README](README.md)。

## 这是什么

成员自购站：老师用学校账号登录，自助申请**腾讯云集团成员账号**，管理员审核后服务端调用腾讯云 `organization` 接口建号。

Next.js 15 + PostgreSQL。**没有推理网关**，本地只有 `postgres` / `portal` / `portal-seed` 三个容器。

## 如果用户说「帮我部署」「在本地跑起来」

先判断是不是**双站一起部署**。出现以下任一表述，就按项目根 [`../QUICKSTART.md`](../QUICKSTART.md) 和 [`../docker-compose.yml`](../docker-compose.yml) 执行：两份门户一起起、共用 nginx 8088、成员账号入口走 8088、同一个 compose / 同一份数据库部署两站。不要只按本目录单站文档部署。

只有明确要求**单独部署成员自购站**时，才按 [`docs/QUICKSTART.md`](docs/QUICKSTART.md) 执行——那是给 AI 的指令文件，含六个阶段、必须向用户提问的两处、验收标准与禁止事项。

[`docs/RUNBOOK-local.md`](docs/RUNBOOK-local.md) 是它的参考手册（端口速查、安装失败处理、卡点表、上线前必改项），卡住时才查，不要拿它替代主流程。

对用户说话用日常语言：说"浏览器打开成员申请页"，不要说"curl 一下 health 接口"。

## 硬性约定

- **与统一采买站共用 `portal_shared`**：`admins`、`app_config`、`login_config`、`settings` 是同一份数据。`src/lib/db/shared-schema.ts` 必须与 `campus-tokenhub-assign` 仓库里的那份**逐字相同**，改完跑 `npm run check:shared-ddl`。
- **登录参数写在 `deploy/init/010-login-config.sql` 顶部的「学校对接参数」块**（provider / 三个 OAuth2 端点 / client_id / CAS 两个地址），由 `portal-seed` 写入；`client_secret` 永不进 SQL。
- **腾讯云 CAM 凭据只在「设置 → 成员组织」填**（加密落库）。本仓库的运行期配置仍保留 env 兜底（与 assign 不同，尚未收口），但一律优先设置页。
- **SecretKey、client_secret 不进任何文件、日志或回复。**
- **端口只绑 `127.0.0.1`**：`3200` 门户、`5433` 数据库。

## 常用命令

| 用途 | 命令 |
| --- | --- |
| 本地开发 | `npm ci && npm run dev:local`（3000 端口） |
| 全栈启动 | `docker compose up -d --build`（3200 端口） |
| 状态 | `docker compose ps -a` |
| 类型检查 | `npm run typecheck` |
| 单测 | `npm test` |
| 共享层 DDL 一致性 | `npm run check:shared-ddl` |
| 跨侧引用检查 | `npm run check:isolation` |

## 改动前先看

- 代码地图与数据契约：[`docs/campus-tokenhub-member-使用教程.md`](docs/campus-tokenhub-member-使用教程.md)
- 双站共存时的 nginx 分流与 Cookie 作用域：`README.md` 的「部署」一节
