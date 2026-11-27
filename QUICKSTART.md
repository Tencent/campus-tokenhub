# 双站部署与验收 · AI 执行指引

> **这是给 AI 助手执行的指令文件**。当用户说「按根目录 QUICKSTART 部署两套门户」「把 assign 和 member 一起跑起来」时，从阶段 0 执行到阶段 3。
> 单站部署不要看这里：统一采买站走 `campus-tokenhub-assign/docs/QUICKSTART.md`，成员自购站走 `campus-tokenhub-member/docs/QUICKSTART.md`。
> 本指引对应项目根的 [`docker-compose.yml`](docker-compose.yml)（一份 compose 同时起两站 + 网关 + nginx）。

---

## 你的目标

在一台机器上用**一份 compose** 同时跑起统一采买站与成员自购站，对外只暴露 nginx 的 8088，并验证两站会话互认、管理员名单共享、`成员账号 ↗` 入口指向 8088。

成功标准（全部满足才算完成）：

1. `http://<host>:8088/tokenhub/portal/api/health` 返回 `{"status":"ok","gateway":true}`
2. `http://<host>:8088/tokenhub/member/members` 返回登录跳转（不是 502 / 404）
3. 侧边栏「成员账号 ↗」指向 `http://<host>:8088/tokenhub/member/members`
4. 在任一站「管理员」页增删管理员，另一站刷新后立即生效
5. 任一站登录后打开另一站，无需二次登录

---

## 执行原则（每一步都适用）

1. **一次一个阶段**。每阶段结束先汇报结果，再进入下一阶段。
2. **需要决策就停下问**，给出编号选项让用户选，不要替用户假设。
3. **同一步失败两次**：停止重试，报告命令、报错原文、你的判断，让用户决定。
4. **密钥不进任何文件、日志、命令参数或你的回复**。OAuth2 `client_secret`、腾讯云 AK/SK、供应商 Key 只能由用户在页面输入。
5. **系统级安装前先告知**（"接下来会弹窗要电脑密码"），得到同意再执行。
6. **不改代码来绕过配置问题**。所有运行期配置只存数据库。
7. **端口冲突先停旧栈**，不要改端口规避：两份单站 compose 也占用 8088 / 5433。

---

## 阶段 0 · 环境自检

```bash
cd <项目根目录 campus-tokenhub>
docker version --format '{{.Server.Version}}' 2>/dev/null   # 需要 24+
docker compose version 2>/dev/null                           # 需要 v2
ls docker-compose.yml campus-tokenhub-assign/.env.dual         # 部署文件与环境模板都要在
```

| 检查 | 不满足时 |
| --- | --- |
| Docker 已安装且运行 | 按 `campus-tokenhub-assign/docs/QUICKSTART.md` 阶段 0 安装，不要交给用户 |
| Compose v2 | 同上 |
| 8088 / 5433 被占用 | 多半是两份旧栈还在，先停（见阶段 2），不要改端口 |
| 机器内存 < 16 G | 构建会慢，耐心等待；不要用混合模式（本文件是全栈） |

---

## 阶段 1 · 准备双站环境变量

双站部署只用一份 env：`campus-tokenhub-assign/.env.dual`。先确认它存在，不存在就从模板复制：

```bash
cp campus-tokenhub-assign/.env.dual.example campus-tokenhub-assign/.env.dual
```

**必须问用户**这两个值，不要自己编：

1. **对外根地址** `PUBLIC_BASE_URL`：浏览器实际访问的地址，本机可用 `http://localhost:8088`，服务器填 `https://<域名>`。必须与 nginx 对外访问一致，否则 302 和 Cookie 会错。
2. **强口令**：`POSTGRES_PASSWORD`、`OCTAFUSE_ADMIN_PASSWORD`。

**自动生成**（不要问用户，直接算，但不要把结果打印到回复里）：

```bash
# 会话签名密钥，两站必须相同；低熵会被启动校验拒绝
SESSION_SECRET=$(openssl rand -base64 48)
# 配置表加密材料，留空会从 SESSION_SECRET 派生（轮换密钥会让已存密文失效，故显式生成）
CONFIG_ENCRYPTION_KEY=$(openssl rand -base64 48)
```

写入 `.env.dual` 后逐项核对：

```bash
grep -E '^(PUBLIC_BASE_URL|SESSION_SECRET|CONFIG_ENCRYPTION_KEY|POSTGRES_PASSWORD|COOKIE_SECURE|PORTAL_COOKIE_PATH|OCTAFUSE_ADMIN_USERNAME|OCTAFUSE_ADMIN_PASSWORD|NGINX_HOST_PORT)=' campus-tokenhub-assign/.env.dual
```

| 变量 | 正确值 | 说明 |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | 用户给的对外地址，**只到域名/端口**（如 `http://localhost:8088`） | 双站部署不要带 `/tokenhub/portal`：compose 会用这个值拼「成员账号」入口与管理台登录地址，带路径会双前缀 |
| `SESSION_SECRET` | 高熵随机串 | 两站共用；字符单一（如 `kkkk…`）会被拒 |
| `CONFIG_ENCRYPTION_KEY` | 高熵随机串 | 同上 |
| `PORTAL_COOKIE_PATH` | `/tokenhub` | **必须是两站公共前缀**，填成各自前缀会各存一份 Cookie、互认断掉 |
| `COOKIE_SECURE` | 本地 `false`，上 TLS `true` | 本地填 true 会被浏览器丢弃 Cookie |
| `OCTAFUSE_ADMIN_USERNAME` / `_PASSWORD` | 非空 | 管理台账密，assign 站依赖 |
| `NEXT_PUBLIC_PROXY_BASE` | 浏览器可达的网关地址（如 `https://<域名>/tokenhub`） | 界面展示的「接口地址 / 示例代码 / 接入脚本」都用它；留空会显示 `/v1/...` 相对地址，复制出去调不通 |
| `ADMIN_PUBLIC_BASE_URL` | 管理台公网地址（如 `http://localhost:8088/tokenhub/admin`） | 留空时侧边栏不显示「网关管理后台」入口 |

登录对接参数（OAuth2 / CAS）由 `portal-seed` 从 `campus-tokenhub-assign/deploy/init/010-login-config.sql` 写入数据库，**只填空值、不覆盖已有配置**。`client_secret` 绝不写进 SQL 或 env，让用户稍后在设置页填。

---

## 阶段 2 · 停旧栈、起双站

**先停旧栈**（如果之前分别部署过，它们也占 8088 / 5433）：

```bash
(cd campus-tokenhub-assign && docker compose down)
(cd campus-tokenhub-member && docker compose down)
```

**再起本文件**（第一次构建镜像要几分钟）：

```bash
docker compose --env-file ./campus-tokenhub-assign/.env.dual up -d --build
```

**等待全部 healthy**（最多 5 分钟，超时就报告卡在哪个服务）：

```bash
docker compose ps
```

正常应看到 8 个服务，其中 `postgres` / `gateway-admin` / `gateway-proxy` / `portal` / `portal-member` / `nginx` 为 `healthy`，`migrate` 与 `portal-seed` 为 `Exited (0)`。

**如果某个服务起不来**：`docker compose logs --tail=80 <服务名>`，报告原文，不要改 compose 绕开。

---

## 阶段 3 · 逐项验收

### 3.1 健康检查

```bash
curl -s http://127.0.0.1:8088/tokenhub/portal/api/health
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://127.0.0.1:8088/tokenhub/member/members
```

期望：第一条返回 `{"status":"ok","gateway":true}`；第二条是 3xx 跳登录页，**不是 502**（502 说明 nginx 解析不到 `portal-member`，检查它是否 healthy）也不是 404（404 说明 member 的 basePath 没打进镜像，需 `--build` 重建）。

### 3.2 成员账号入口指向 8088

让用户浏览器打开 `http://<host>:8088/tokenhub/portal`，看侧边栏「成员账号 ↗」。点开后地址栏应是 `http://<host>:8088/tokenhub/member/members`。

- 入口不显示：`MEMBER_PUBLIC_BASE_URL` 为空，检查阶段 1 的 env。
- 地址是 3200 / 3000 等直连端口：env 里手填了旧值，删掉让它按 `PUBLIC_BASE_URL/tokenhub/member` 自动生成。

### 3.3 管理员名单共享

在**统一采买站**「管理员」页加一个测试身份，再到**成员站**「管理员」页刷新查看；反向再试一次。两边看到的名单一致才通过。

### 3.4 会话互认

在统一采买站登录，直接打开成员站页面，应无需二次登录；反之亦然。失败时核对 `SESSION_SECRET` 一致、`PORTAL_COOKIE_PATH=/tokenhub`、`COOKIE_SECURE` 与协议匹配。

### 3.5 输出验证报告

汇报：各服务状态、两条 health 结果、`成员账号` 入口实际地址、管理员名单双向验证结果、会话互认结果。失败项标红并给出下一步建议。

---

## 失败处理

| 现象 | 先查 |
| --- | --- |
| `port 8088 is already allocated` | 旧栈没停干净：`docker ps`，对残留栈执行 `compose down` |
| `portal-member` 502 | 该服务是否 healthy；nginx 与它是否同一 compose 网络 |
| 成员站页面 404 / `_next` 资源 404 | 镜像未带 basePath：确认 compose 里 `build.args.PORTAL_BASE_PATH=/tokenhub/member` 且用了 `--build` |
| 登录后跳回登录页 | 两站 Cookie 冲突：`PORTAL_COOKIE_PATH=/tokenhub`、清浏览器同名 Cookie、确认没有再从直连端口访问 |
| 管理台 401 | `PORTAL_SESSION_SECRET` 是否与两站 `SESSION_SECRET` 一致 |
| 「接入指南」里的接口地址是 `localhost:8790` 或 `/v1/...` | `NEXT_PUBLIC_PROXY_BASE` 没配或配成了容器内地址：改成浏览器可达的网关地址（如 `https://<域名>/tokenhub`），两站镜像要带 `--build` 重建 |
| 侧边栏没有「网关管理后台」入口 | `ADMIN_PUBLIC_BASE_URL` 留空时不显示该入口；填成 `http://<host>:8088/tokenhub/admin` |
| 构建失败 | `docker compose build <服务名>` 看完整输出；不要改 Dockerfile 绕开 |

---

## 禁止事项

- 不要为了省事把两站拆成两份 compose——本指引的唯一目标就是一份文件起两站。
- 不要把管理员名单写回 env；名单只存数据库 `portal_shared.admins`。
- 不要改端口来规避冲突；停掉占用者。
- 不要把任何真实密钥写进 compose、.env、日志或你的回复。
- 不要在没得到用户同意的情况下做系统级安装。
