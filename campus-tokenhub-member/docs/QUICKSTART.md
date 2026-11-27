# 成员站本地部署与调试验证 · AI 执行指引

> **这是给 AI 助手执行的指令文件**，不是给人读的教程。
> 当用户说「按 docs/QUICKSTART.md 帮我完成本地部署和调试」时，从阶段 0 执行到阶段 5。
> 端口与排障见 [`RUNBOOK-local.md`](RUNBOOK-local.md)。
> 服务器上还没装 CodeBuddy CLI 的，先按 [`INSTALL-CODEBUDDY-CLI.md`](INSTALL-CODEBUDDY-CLI.md) 装好再来。

本仓库是**成员自购站**（老师自助申请腾讯云集团成员账号）。它没有推理网关，本地只需 3 个容器。

---

## 你的目标

验证这条链路：**启动 → 学校账号登录 → 配置腾讯云凭据 → 提交申请 → 管理员审核**。

成功标准（按能做到的深度分层，报告里要写清做到哪层）：

| 层级 | 标准 | 前提 |
| --- | --- | --- |
| 必须 | health 返回 `{"status":"ok","database":true}` | 无 |
| 必须 | 用户能用学校账号登录（或明确记录"暂未接 SSO"） | SSO 参数 |
| 应当 | `/members` 页从"暂未开放"变成可提交的申请表 | 腾讯云 CAM 凭据 |
| 加分 | 提交一条申请并审核通过，拿到成员账号结果 | CAM 有组织写权限 |

---

## 执行原则

1. **一次一个阶段**，每阶段结束先汇报再往下。
2. **需要决策就停下问**，给编号选项，不要替用户假设。
3. **同一步失败两次**：停止重试，报告命令、报错原文与判断。
4. **密钥不进任何文件、日志、命令参数或回复**：`client_secret`、腾讯云 `SecretKey` 只能由用户在页面输入。
5. **系统级安装前先告知**（"会弹窗要电脑密码"），得到同意再执行。
6. **不改代码绕过配置问题。**

---

## 阶段 0 · 环境自检

```bash
docker version --format '{{.Server.Version}}' 2>/dev/null   # 需要 24+
docker compose version 2>/dev/null                           # 需要 v2
```

| 检查 | 不满足时 |
| --- | --- |
| Docker 未安装/未运行 | 执行下方「安装 Docker」，不要交给用户 |
| 内存 < 8 G | 仍可用全栈（本仓库不构建网关，内存压力小） |
| 3000 / 3200 / 5433 被占用 | 改 `.env` 的 `PORTAL_HOST_PORT` / `POSTGRES_HOST_PORT` |

**安装 Docker**（先告诉用户"会弹窗要密码"）：

```bash
# macOS（有 brew）
brew install --cask docker

# macOS（无 brew，Apple Silicon；Intel 换 amd64）
curl -L -o /tmp/Docker.dmg https://desktop.docker.com/mac/main/arm64/Docker.dmg
hdiutil attach /tmp/Docker.dmg -nobrowse && cp -R /Volumes/Docker/Docker.app /Applications/ && hdiutil detach /Volumes/Docker
open -a Docker

# Windows（管理员 PowerShell）
winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements

# Linux（sudo，先征得同意）
curl -fsSL https://get.docker.com | sh
```

等就绪：

```bash
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 5; done
docker info --format '{{.ServerVersion}}'
```

**本仓库不构建网关镜像**，所以首次启动只要 2–3 分钟，不是 20 分钟。

---

## 阶段 1 · 必须问用户的两个问题

### 问题 1：学生用哪种登录方式？

| 选项 | 后续动作 |
| --- | --- |
| **A. OAuth2** | 要 5 个参数（secret 让用户在页面填） |
| **B. CAS** | 要 2 个地址，并先确认学校能否把 `localhost` 加进 service 白名单 |
| **C. 暂时不接** | 跳过 SSO，用引导账号验证 |

选 A 时一次要齐：授权端点、Token 端点、UserInfo 端点、Client ID、Client Secret（**不收 secret**）。

提醒用户把回调地址加进 IdP 白名单：
`http://localhost:3200/tokenhub/member/api/auth/callback`

选 B 时先问：**学校能否把 `localhost` 加进 CAS Server 的 service 白名单？** 不能就建议改选 C。

### 问题 2：有没有腾讯云 CAM 子账号凭据？

这个站的**核心功能是创建腾讯云集团成员账号**，没有凭据时 `/members` 会显示「成员账号申请暂未开放」。所以必须先问清楚。

| 回答 | 影响 |
| --- | --- |
| 有 SecretId / SecretKey | 能验证到「提交申请 → 审核 → 建号」 |
| 没有 | 只能验证登录、设置页与健康检查；`/members` 保持"暂未开放"，在报告里注明 |

需要什么样的子账号（告诉用户）：

- 在腾讯云控制台 → 访问管理创建子账号，授权 `QcloudOrganizationFullAccess`（或至少组织成员管理权限）；
- 需要组织根节点已存在（学校已在腾讯云开通集团账号）；
- 财务权限按需要给（默认「查看账单 + 查看余额」）。

**SecretKey 只让用户在设置页输入**，不要收进对话。

---

## 阶段 2 · 写配置

### 2.1 登录参数写进初始化 SQL

文件：`deploy/init/010-login-config.sql`，**只改顶部「学校对接参数」块**。

```sql
-- OAuth2
\set school_auth_provider 'oauth2'
\set school_oauth2_authorization_endpoint '<授权端点>'
\set school_oauth2_token_endpoint '<Token 端点>'
\set school_oauth2_user_info_endpoint '<UserInfo 端点>'
\set school_oauth2_client_id '<Client ID>'

-- CAS
\set school_auth_provider 'cas'
\set school_cas_login_url '<CAS 认证地址>'
\set school_cas_ticket_validate_url '<Ticket 校验地址>'
```

选 C 就全部保持空字符。`client_secret` 永不入本文件。

### 2.2 生成 `.env`

```bash
cp .env.example .env
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -hex 12      # PORTAL_ADMIN_PASSWORD：人登录用的部署管理员口令
```

`PORTAL_ADMIN_PASSWORD` 是**唯一给人用的口令**。首次启动会把它加密写进共享配置，此后以库内为准，改 `.env` 不再生效（启动日志会提示被忽略）。与统一采买站同库部署时两站读同一行、天然一致；分栈部署（两个库）则必须把两处写成同一个值。

确认这几项：

```bash
SESSION_SECRET=<生成值>
POSTGRES_PASSWORD=<生成值>
OCTAFUSE_EXTERNAL_SYSTEM=campus-tokenhub

# .env.example 已默认 /tokenhub/member，确认没被改空
PORTAL_BASE_PATH=/tokenhub/member
PUBLIC_BASE_URL=http://localhost:3200/tokenhub/member
COOKIE_SECURE=false

# 引导账号
PORTAL_ADMIN_USERNAME=ops-admin
PORTAL_ADMIN_PASSWORD=<生成值>
PORTAL_ADMIN_LOGIN=auto
```

注意：

- `OCTAFUSE_ADMIN_BASE` / `OCTAFUSE_ADMIN_PASSWORD` 是网关配置，**本站不需要**，留空或保持示例值都不影响启动；
- `TENCENTCLOUD_SECRET_ID` / `_SECRET_KEY` **不要写进 `.env`**，走设置页（加密落库）。env 里即使有值，设置页保存后也以数据库为准；
- 本仓库的运行期配置**仍保留 env 兜底**（与统一采买站不同，尚未收口），但一律优先用设置页。

校验：`docker compose config >/dev/null && echo ok`

---

## 阶段 3 · 启动

```bash
docker compose up -d --build
docker compose ps -a     # portal healthy；portal-seed 为 Exited (0)
```

只有 `postgres` / `portal` / `portal-seed` 三个服务。首次构建 2–3 分钟。

混合开发模式（改代码看热更新）：

```bash
docker compose up -d postgres
npm ci
npm run dev:local        # 门户跑在宿主机 3000
```

---

## 阶段 4 · 逐项验收

### 4.1 健康检查

```bash
# 全栈
curl -s http://127.0.0.1:3200/tokenhub/member/api/health
# 混合模式
curl -s http://127.0.0.1:3000/tokenhub/member/api/health
```

期望 `{"status":"ok","database":true}`（本站没有网关，不返回 `gateway` 字段）。

### 4.2 确认登录参数落库

```bash
docker compose exec -T postgres psql -U octafuse -d octafuse -c \
  "select provider, oauth2_client_id, oauth2_authorization_endpoint,
          cas_login_url, (oauth2_client_secret_enc is null) as secret_empty
     from portal_shared.login_config"
```

不符就修 SQL 再重跑：

```bash
docker compose exec -T postgres psql -U octafuse -d octafuse \
  -v ON_ERROR_STOP=1 -f - < deploy/init/010-login-config.sql
```

### 4.3 引导账号登录

**告诉用户**："浏览器打开 `http://localhost:3200/tokenhub/member/login`，用 `ops-admin` 和刚才的口令登录，登录后应该看到设置页。"

验收：落在 `/settings`。

### 4.4 让用户填 Client Secret

**告诉用户**："请点「登录认证」，五个框里已经填好四个，只剩密钥空着，你自己粘贴进去再保存。"

**不要替用户输入密钥。** 保存后跳回登录页、只剩「使用学校账号登录」即为对接成功。

### 4.5 学校账号登录

**告诉用户**："点「使用学校账号登录」，用工号密码登录，回来后告诉我。"

验收：落在 `/members`。若显示「成员账号申请暂未开放」，属于下一项要解决的（缺腾讯云凭据），**不是登录失败**。

### 4.6 配置腾讯云凭据（有凭据时）

**告诉用户**："请到「系统设置 → 成员组织」，填入 SecretId 和 SecretKey，点「检测」。"

- 检测通过后，`/members` 会自动从"暂未开放"变成申请表；
- 检测失败：看报错是权限不足（缺 `QcloudOrganizationFullAccess`）还是密钥错误；
- 没有凭据就跳过本项，在报告里注明"仅验证到登录"。

### 4.7 提交一条申请（有凭据时）

**告诉用户**："在「成员账号」页填一条申请，部门与备注按实际填，提交后告诉我。"

验收：状态变成"等待管理员审核"。

### 4.8 审核（有凭据时）

管理员进 `/members/review`，对刚才的申请点通过。

验收：

- 状态变为已通过；
- 服务端调用腾讯云 `organization` 接口建号，成功后页面显示成员账号信息（UIN / 登录名）；
- 失败时页面会显示腾讯云返回的错误码，把它记进报告。

同一账号既是申请人又是管理员时，可以直接自审，本地验证够用。

---

## 阶段 5 · 输出验证报告

```
本地验证结果

访问地址：http://localhost:3200/tokenhub/member
登录方式：OAuth2 / CAS / 暂未接
账号：可用学校账号登录（姓名：xxx）
腾讯云凭据：已配置并通过检测 / 未配置
成员申请：已提交并通过审核，账号 xxx / 仅验证到登录

验证深度：到第 N 层

未完成：
- （如有，写清原因）

下一步：
- 正式上线需要服务器、域名与证书，按 docs/campus-tokenhub-member-使用教程.md 做
- 上线后把正式域名的回调地址交给学校登记，并把腾讯云凭据重新在设置页填一次（换机器后旧密文解不开）
```

同时列出实际写入的登录参数（不含 secret）。

---

## 失败处理

| 现象 | 你的动作 |
| --- | --- |
| `/members` 显示"暂未开放" | 正常：没配腾讯云凭据。配了还这样 → 看"检测"结果 |
| 检测凭据报权限不足 | 子账号缺 `QcloudOrganizationFullAccess`，让用户补权限 |
| 建号失败并返回错误码 | 记录原始错误码与 RequestId，不要反复重试 |
| 种子查询为空 | 检查 SQL 顶部参数与表名 `portal_shared.login_config` |
| 页面 404 | 确认 `PORTAL_BASE_PATH=/tokenhub/member`，且访问地址带前缀 |
| 登录成功又跳回登录页 | 清 `portal_session` Cookie；确认没混用 3000 与 3200 |
| 全栈起不来 | `docker compose logs portal`；确认 `.env` 没残留网关必填项 |

更多见 [`RUNBOOK-local.md`](RUNBOOK-local.md)。

---

## 禁止事项

- 不把 `client_secret`、腾讯云 `SecretKey` 写进任何文件、日志或回复。
- 不代替用户输入密钥。
- 不用改代码绕过配置或校验。
- 同一阶段不连续试错超过两次。
- 不访问 `localhost` 以外的站点。
