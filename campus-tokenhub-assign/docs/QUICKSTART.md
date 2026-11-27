# 本地部署与调试验证 · AI 执行指引

> **这是给 AI 助手执行的指令文件**，不是给人读的教程。
> 当用户说「按 docs/QUICKSTART.md 帮我完成本地部署和调试」时，从阶段 0 执行到阶段 5。
> 命令细节与排障见 [`RUNBOOK-local.md`](RUNBOOK-local.md)，本文引用处标注了节号。
> 服务器上还没装 CodeBuddy CLI 的，先按 [`INSTALL-CODEBUDDY-CLI.md`](INSTALL-CODEBUDDY-CLI.md) 装好再来。

---

## 你的目标

在这台电脑上把门户跑起来，验证完整链路：**启动 → 登录 → 领密钥 → 调一次模型**，最后给用户一份可核对的验证报告。

成功标准（全部满足才算完成）：

1. `/tokenhub/portal/api/health` 返回 `{"status":"ok","gateway":true}`
2. 用户能用**自己的学校账号**登录（或明确记录为"暂未接 SSO"）
3. 页面能领到 `sk-` 开头的密钥
4. 有条件时，调试页能收到模型返回

---

## 执行原则（每一步都适用）

1. **一次一个阶段**。每阶段结束先汇报结果，再进入下一阶段。
2. **需要决策就停下问**，给出编号选项让用户选，不要替用户假设。
3. **同一步失败两次**：停止重试，报告命令、报错原文、你的判断，让用户决定。
4. **密钥不进任何文件、日志、命令参数或你的回复**。`client_secret` 与供应商 Key 只能由用户在页面输入。
5. **系统级安装前先告知**（"接下来会弹窗要电脑密码"），得到同意再执行。
6. **不改代码来绕过配置问题**。所有运行期配置只存数据库。

---

## 阶段 0 · 环境自检

```bash
docker version --format '{{.Server.Version}}' 2>/dev/null   # 需要 24+
docker compose version 2>/dev/null                           # 需要 v2
```

逐项判断：

| 检查 | 不满足时 |
| --- | --- |
| Docker 已安装且运行 | 执行下方「安装 Docker」，不要交给用户 |
| Compose 为 v2 | 同上，装新版 Docker Desktop 自带 |
| 内存 < 16 G | 走混合模式（只起网关，门户跑 dev） |
| 8088 / 3000 / 8790 被占用 | 改 `.env` 的 `NGINX_HOST_PORT` / `PORTAL_HOST_PORT` |

**安装 Docker**（先告诉用户"会弹窗要密码"，再执行）：

```bash
# macOS（有 brew）
brew install --cask docker

# macOS（无 brew，Apple Silicon；Intel 换 amd64）
curl -L -o /tmp/Docker.dmg https://desktop.docker.com/mac/main/arm64/Docker.dmg
hdiutil attach /tmp/Docker.dmg -nobrowse && cp -R /Volumes/Docker/Docker.app /Applications/ && hdiutil detach /Volumes/Docker
open -a Docker

# Windows（管理员 PowerShell）
winget install --id Docker.DockerDesktop -e --accept-package-agreements --accept-source-agreements

# Linux（sudo，需先征得同意）
curl -fsSL https://get.docker.com | sh
```

等就绪（超过 5 分钟让用户确认 Docker Desktop 是否已完成首次启动向导）：

```bash
for i in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 5; done
docker info --format '{{.ServerVersion}}'
```

装不上时，把官方下载页给用户，让他手动装，装完继续。

---

## 阶段 1 · 必须问用户的两个问题

**不许猜。** 用编号选项提问，拿到答案再往下走。

### 问题 1：学生用哪种登录方式？

| 选项 | 后续动作 |
| --- | --- |
| **A. OAuth2** | 继续要 5 个参数 |
| **B. CAS** | 要 2 个地址，并先判断白名单可行性 |
| **C. 暂时不接** | 跳过 SSO，用引导账号验证门户本体 |

**选 A 时**，一次要齐（缺一项都不要开始写配置）：

| 参数 | 向用户怎么问 |
| --- | --- |
| 授权端点 | 学生点登录后跳转的地址 |
| Token 端点 | 换取身份的地址 |
| UserInfo 端点 | 读取用户信息的地址 |
| Client ID | 应用编号 |
| Client Secret | 应用密钥 —— **让用户自己在页面填，不要收** |

同时提醒用户把回调地址加进 IdP 白名单：
`http://localhost:3000/tokenhub/portal/api/auth/callback`

**选 B 时**，先问一句：**学校能否把 `localhost` 加进 CAS Server 的 service 白名单？**

- 能 → 收 `cas_login_url` 与 `cas_ticket_validate_url`；
- 不能或不确定 → 建议用户改选 C（CAS 留到上线用正式域名验）。**不要试图绕过校验。**

### 问题 2：有没有供应商 API Key？

有 → 阶段 4 可验证真实模型调用；没有 → 验证到「已领到密钥」即止。

---

## 阶段 2 · 写配置

### 2.1 登录参数写进初始化 SQL

文件：`deploy/init/010-login-config.sql`，**只改顶部「学校对接参数」块**，不要动下面的执行逻辑。

按阶段 1 的答案替换对应行：

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

规则：

- 选 C（暂不接）就**全部保持空字符**，脚本不会写入任何值；
- **`client_secret` 永不写入本文件**，它只能在设置页填一次；
- 标准 OAuth2 不要动 `token_auth_method` / `carrier`（留空即用默认值）；
- 只有身份字段名不标准（userinfo 里不叫 `sub` / `name`，或身份要用 `school_id:user_id` 拼接）时才需要字段映射，见该文件末尾的注释块。

### 2.2 生成 `.env`

```bash
cp .env.example .env
openssl rand -base64 48   # SESSION_SECRET
openssl rand -hex 24      # POSTGRES_PASSWORD
openssl rand -hex 12      # PORTAL_ADMIN_PASSWORD：人登录用的部署管理员口令
openssl rand -base64 18   # OCTAFUSE_ADMIN_PASSWORD：门户调网关 API 的服务账号
```

**只有一个口令是给人用的**：`PORTAL_ADMIN_PASSWORD`。首次启动会把它加密写进共享配置，此后以库内为准，改 `.env` 不再生效。同库双站部署两站读同一行、天然一致；分栈部署（两个库）则必须把两处写成同一个值。网关管理台（`ADMIN_AUTH_MODE=portal`）用同一套 portal 账号登录，不需要第三个口令；`OCTAFUSE_ADMIN_*` 是机器对机器的服务凭据，别当登录口令用。

写入以下键（值用上一步生成）：

```bash
SESSION_SECRET=
POSTGRES_PASSWORD=
OCTAFUSE_ADMIN_USERNAME=admin
OCTAFUSE_ADMIN_PASSWORD=
OCTAFUSE_EXTERNAL_SYSTEM=campus-tokenhub

# 本地也必须带前缀，否则页面 404
PORTAL_BASE_PATH=/tokenhub/portal
PUBLIC_BASE_URL=http://localhost:3000/tokenhub/portal
NEXT_PUBLIC_PROXY_BASE=http://localhost:8790
ADMIN_UI_PUBLIC_PATH=/tokenhub/admin
ADMIN_PUBLIC_BASE_URL=http://localhost:8088/tokenhub/admin
COOKIE_SECURE=false
ADMIN_COOKIE_SECURE=
NGINX_PUBLIC_PROTO=http

PORTAL_ADMIN_USERNAME=ops-admin
PORTAL_ADMIN_PASSWORD=
PORTAL_ADMIN_LOGIN=auto
```

**不要**把 SSO 参数写进 `.env`，写进去不生效，启动日志会列出被忽略的键。

校验：`docker compose config >/dev/null && echo ok`

---

## 阶段 3 · 启动

**全栈**（内存 ≥ 16 G）：

```bash
docker compose up -d --build
docker compose ps -a     # 5 个 healthy；migrate / portal-seed 为 Exited (0)
```

**混合模式**（内存紧张或要改代码）：

```bash
docker compose up -d postgres migrate gateway-proxy gateway-admin
npm ci
npm run dev:local        # 后台运行，改代码热更新
```

首次构建网关镜像 10–20 分钟。混合模式没有 nginx，管理台外链打不开是预期，不是故障。

---

## 阶段 4 · 逐项验收

按顺序做，每项都要拿到证据再进下一项。

### 4.1 健康检查

```bash
curl -s http://127.0.0.1:8088/tokenhub/portal/api/health   # 全栈
curl -s http://127.0.0.1:3000/tokenhub/portal/api/health   # 混合
```

期望 `{"status":"ok","gateway":true}`。`gateway:false` → 查 `docker compose logs gateway-admin`，并确认 `.env` 的 `OCTAFUSE_ADMIN_BASE` 是容器内服务名。

### 4.2 确认登录参数真的落库

```bash
docker compose exec -T postgres psql -U octafuse -d octafuse -c \
  "select provider, oauth2_client_id, oauth2_authorization_endpoint,
          cas_login_url, (oauth2_client_secret_enc is null) as secret_empty
     from portal_shared.login_config"
```

期望：`provider` 与阶段 1 的选择一致；端点与 client_id 与你写入的一致；`secret_empty = t`。

不符时不要继续 —— 先修 SQL 再重跑：

```bash
docker compose exec -T postgres psql -U octafuse -d octafuse \
  -v ON_ERROR_STOP=1 -f - < deploy/init/010-login-config.sql
```

### 4.3 引导账号登录

**告诉用户**："浏览器会打开登录页，请用 `ops-admin` / 你给的口令登录，登录后应该看到「设置」页面。"

- 全栈：`http://localhost:8088/tokenhub/portal/login`
- 混合：`http://localhost:3000/tokenhub/portal/login`

验收：落在 `/settings`。失败查 RUNBOOK 卡点表。

### 4.4 让用户自己填 Client Secret

如果阶段 1 选的是 A 或 B：

**告诉用户**："请点左侧「登录认证」，五个框里已经填好四个，只剩密钥空着。请你自己把密钥粘贴进去，然后点保存。填完告诉我。"

**不要替用户输入密钥，也不要让他把密钥发给你。** 保存后页面会跳回登录页、只剩「使用学校账号登录」——这是对接成功的唯一判据。

### 4.5 学校账号登录

**告诉用户**："请点「使用学校账号登录」，用工号密码登录，回到门户后告诉我。"

验收：回到 `/overview`，侧边栏显示学校名与姓名。

失败先查这两项：

- IdP 报 `redirect_uri` / `service` 不合法 → 回调地址未登记，把完整地址给用户去登记；
- 登录后立刻跳回登录页 → 清 `portal_session` Cookie 再试。

选 C 的用户跳过本项，在报告里标注"未接 SSO"。

### 4.6 领密钥

**告诉用户**："请点「领取密钥」，把出现的 `sk-` 开头字符串复制到记事本，只显示一次。"

验收：页面上出现 Key。用户拿不到时检查额度限制或网关报错。

### 4.7 调一次模型（有供应商 Key 时）

**告诉用户**："请点密钥旁边的「调试」，选一个模型，输入「你好」发送，告诉我能否看到回答。"

验收：调试页出现流式返回；`/dashboard` 有调用记录。

没有供应商 Key：到「初始化」页面接入一家；仍无云账号则跳过本项。

---

## 阶段 5 · 输出验证报告

用这个结构回复用户，不要写技术术语：

```
本地验证结果

访问地址：http://localhost:8088/tokenhub/portal
登录方式：OAuth2 / CAS / 暂未接
账号：可用学校账号登录（姓名：xxx）
密钥：已领取
模型：已调通（模型名）/ 未验证（没有供应商密钥）

未完成：
- （如有）

下一步：
- 正式上线需要服务器（16C/32G/1TB）、域名与证书，按 docs/campus-tokenhub-assign-使用教程.md 第 1 章做
- 上线后记得把正式域名的回调地址给学校登记
```

同时列出"这次实际写入的登录参数"（不含 secret），方便用户核对。

---

## 失败处理

| 现象 | 你的动作 |
| --- | --- |
| Docker 装不上 | 给官方下载页，让用户手动装，装完继续 |
| 构建超过 30 分钟 | 看 `docker compose logs` 判断卡在哪个服务，报告给用户 |
| health 返回 `gateway:false` | 查 gateway-admin 日志与 `OCTAFUSE_ADMIN_BASE` |
| 种子查询为空 | 检查 SQL 顶部参数是否填了、表名是否为 `portal_shared.login_config` |
| 保存参数报「Client Secret 不能为空」 | 让用户把五项一次填全再保存 |
| 页面 404 但容器 healthy | 确认 `.env` 的 `PORTAL_BASE_PATH=/tokenhub/portal`，改完 `--build` |
| 全栈 nginx 502 | `docker compose restart nginx` |
| 混合模式管理台入口 404 | 预期行为，改用全栈验证 |

细节与更多卡点见 [`RUNBOOK-local.md`](RUNBOOK-local.md)。

---

## 禁止事项

- 不把 `client_secret`、供应商 Key 写进任何文件、日志或回复。
- 不代替用户输入密钥。
- 不用改代码的方式绕过配置或校验。
- 不在同一阶段连续试错超过两次。
- 不访问 `localhost` 以外的站点。
