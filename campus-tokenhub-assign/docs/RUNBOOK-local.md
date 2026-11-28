# 本地部署参考（命令与排障）

主流程是 [`QUICKSTART.md`](QUICKSTART.md)（给 AI 执行的指引）。本页只放**它需要查的东西**：端口速查、安装失败处理、完整卡点表、上线前必改项。

正常部署不需要读本页。

---

## 端口与地址速查

| 服务 | 全栈 | 混合模式 | 说明 |
| --- | --- | --- | --- |
| 门户页面 | `http://localhost:8088/tokenhub/portal` | `http://localhost:3000/tokenhub/portal` | 必须带前缀 |
| 健康检查 | `:8088/tokenhub/portal/api/health` | `:3000/tokenhub/portal/api/health` | 期望 `gateway:true` |
| 网关代理 | `http://localhost:8790` | 同左 | 浏览器调试台的落点 |
| 管理台 | `http://localhost:8088/tokenhub/admin` | 不可用（无 nginx） | 需要登录态 |
| 数据库 | `127.0.0.1:5433` | 同左 | 宿主机调试用 |

改端口：`.env` 的 `NGINX_HOST_PORT` / `PORTAL_HOST_PORT` / `GATEWAY_PROXY_HOST_PORT`。

---

## Docker 安装失败的处理

| 平台 | 常见报错 | 处理 |
| --- | --- | --- |
| macOS | `brew: command not found` | 改用手动下载 dmg；或先装 Homebrew |
| macOS | `Cannot connect to the Docker daemon` | `open -a Docker`，等 60–120 秒；首次启动要接受协议 |
| macOS | 提示"应用已损坏" | 系统设置 → 隐私与安全性 → 仍要打开 |
| Windows | `winget` 不存在 | 用官网安装包；或先装 App Installer |
| Windows | 提示需要 WSL2 | 管理员 PowerShell 执行 `wsl --install`，重启后再装 |
| Windows | daemon 不启动 | BIOS 里确认虚拟化已开；Hyper-V 与 WSL2 冲突时二选一 |
| Linux | `permission denied /var/run/docker.sock` | `sudo usermod -aG docker $USER` 后重新登录 |
| 任意 | 旧版 Docker 残留 | 卸载旧版（Docker Toolbox / 旧 daemon）再装 |

装完必须验证：

```bash
docker info --format '{{.ServerVersion}}'
docker compose version
```

---

## 完整卡点表

| 现象 | 判断依据 | 处理 |
| --- | --- | --- |
| 页面 404，容器全 healthy | 请求路径不带前缀也通 | `.env` 的 `PORTAL_BASE_PATH` 必须是 `/tokenhub/portal`，改完 `--build` |
| 页面能开但静态资源 404 | 控制台 `/_next/...` 报错 | 同上，构建期参数不一致 |
| 全栈 nginx 502 | `docker compose logs nginx` 有 `connect() failed` | 应用容器重建后 IP 变了，`docker compose restart nginx` |
| health `gateway:false` | `logs gateway-admin` 有 401 或连接拒绝 | 检查 `OCTAFUSE_ADMIN_API_KEY` 是否有效且权限齐全、`OCTAFUSE_ADMIN_BASE`（容器内是服务名） |
| 种子执行了但库是空的 | 查 `login_config` 全 NULL | SQL 顶部参数没填；或表名写错（必须是 `portal_shared.login_config`） |
| `migrate` 退出码 1 | `logs migrate` 显示认证失败 | `POSTGRES_PASSWORD` 与 compose 插值不一致；确认 `.env` 无多余空格 |
| 登录成功又跳回登录页 | 浏览器有两个同名 `portal_session` | 清 Cookie；确认没有同时从 3000 和 8088 访问过 |
| 点登录报 `redirect_uri` 不合法 | IdP 页面显示回调地址 | 把完整地址给学校登记白名单：`http://localhost:3000/tokenhub/portal/api/auth/callback` |
| CAS 报 `service` 未授权 | CAS Server 拒绝 | 学校没把 localhost 加白；改用「暂不接 SSO」，上线后用正式域名验 |
| 保存登录参数返回 400 | 提示"Client Secret 不能为空" | 设置页整表提交，五项要一次填全 |
| 领 Key 报错 | `/api/portal/keys` 返回 5xx | 网关不可用；看 `logs gateway-proxy` |
| 调试页一直转圈 | 网络面板无响应 | 供应商 Key 失效或模型未接入；到「初始化」重测 |
| 构建卡住 > 30 分钟 | `docker compose logs` 停在拉包 | 网络问题；重试或换镜像源 |
| 混合模式管理台 404 | 只有 8088 才有 admin 路由 | 预期行为，改用全栈验证 |

---

## 上线前必须改的五项

本地验证通过后，`.env` 与 SQL 都要改，**不要直接拷到服务器**：

| 位置 | 本地值 | 上线值 |
| --- | --- | --- |
| `.env` `PUBLIC_BASE_URL` | `http://localhost:3000/tokenhub/portal` | `https://<域名>/tokenhub/portal` |
| `.env` `ADMIN_PUBLIC_BASE_URL` | `http://localhost:8088/tokenhub/admin` | `https://<域名>/tokenhub/admin` |
| `.env` `COOKIE_SECURE` / `ADMIN_COOKIE_SECURE` | `false` / 空 | `true` / `1` |
| `.env` `NGINX_PUBLIC_PROTO` | `http` | `https` |
| `deploy/init/010-login-config.sql` | 若填了 localhost 相关地址 | 换成正式域名下的地址 |

另外要把 `https://<域名>/tokenhub/portal/api/auth/callback` 重新登记到 IdP / CAS 白名单。

完整上线流程见 [`campus-tokenhub-assign-使用教程.md`](campus-tokenhub-assign-使用教程.md) 第 1 章。
