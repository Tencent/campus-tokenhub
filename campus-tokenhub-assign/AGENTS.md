# AGENTS.md

给在这个仓库里工作的 AI 助手。人看的文档见 [README](README.md)。

## 这是什么

学校 AI 模型门户（统一采买站）。Next.js 15 + PostgreSQL，推理网关源码在 `local-stack/octafuse-gateway`。

## 如果用户说「帮我部署」「在本地跑起来」「按仓库指引部署」

先判断是不是**双站一起部署**。出现以下任一表述，就按项目根 [`../QUICKSTART.md`](../QUICKSTART.md) 和 [`../docker-compose.yml`](../docker-compose.yml) 执行：两份门户一起起、共用 nginx 8088、成员账号入口走 8088、同一个 compose / 同一份数据库部署两站。不要只按本目录单站文档部署。

只有明确要求**单独部署统一采买站**时，才按 [`docs/QUICKSTART.md`](docs/QUICKSTART.md) 从头执行——那是给 AI 的指令文件，含六个阶段、必须向用户提问的两处、每步验收标准和禁止事项。

[`docs/RUNBOOK-local.md`](docs/RUNBOOK-local.md) 是它的参考手册（端口速查、安装失败处理、完整卡点表、上线前必改项），只在 QUICKSTART 指向或卡住时查阅，不要拿它替代主流程。

对用户说话时用日常语言：说"浏览器打开登录页、用这个账号登录"，不要说"执行 curl 验证 health 接口"。

如果用户说「上服务器部署」，按 [`docs/campus-tokenhub-assign-使用教程.md`](docs/campus-tokenhub-assign-使用教程.md) 第 1 章执行。

## 硬性约定（改代码前必须知道）

- **运行期配置只存数据库**：学校名称、开户额度、限流、SSO 参数（含 OAuth2 Client Secret）、CAS 地址，全部通过「设置」页维护，保存即生效。这些字段**不读环境变量**，往 `.env` 里加不会生效，启动日志会提示被忽略。
- **唯一保留的 env 业务配置是引导账号**（`PORTAL_ADMIN_USERNAME` / `_PASSWORD` / `_LOGIN`），用途是首次部署进入设置页。
- **登录对接参数写在 `deploy/init/010-login-config.sql` 顶部的「学校对接参数」块**（provider / 三个 OAuth2 端点 / client_id / CAS 两个地址），由 `portal-seed` 写入数据库；`client_secret` 永不进 SQL，只能由用户在设置页输入。
- **系统级安装（Docker、WSL）前先告知用户会弹窗要密码**，得到同意再执行。
- **管理员判定三层**：引导账号 → `portal_shared.admins` 名单 → 名单为空时初始化 owner。没有邮箱白名单；名单非空时不再回落 owner。另有「登录认证 → 管理员角色同步」：登录时把命中角色的用户写入名单（只增不减），不改变上述判定顺序。
- **真实密钥不进任何文件、日志或回复**。Client Secret、供应商 API Key 由用户在设置页输入。
- **端口只对外暴露 nginx 8088**，其余服务绑 `127.0.0.1`。

## 常用命令

| 用途 | 命令 |
| --- | --- |
| 本地开发 | `npm ci && npm run dev:local` |
| 全栈启动 | `docker compose up -d --build` |
| 状态 | `docker compose ps -a` |
| 类型检查 | `npm run typecheck` |
| 单测 | `npm test` |
| 跨侧引用门禁 | `npm run check:isolation` |
| 共享层 DDL 门禁 | `npm run check:shared-ddl` |

## 改动前先看

- 代码地图、常见改动示例、数据契约：[`docs/campus-tokenhub-assign-使用教程.md`](docs/campus-tokenhub-assign-使用教程.md) 第 4 章
- 架构与请求路径：`README.md` 的「系统架构」
- 提交前跑完四个门禁（typecheck / test / isolation / shared-ddl）
