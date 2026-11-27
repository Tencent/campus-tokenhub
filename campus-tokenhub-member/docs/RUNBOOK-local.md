# 成员站本地部署参考（命令与排障）

主流程是 [`QUICKSTART.md`](QUICKSTART.md)（给 AI 执行的指引）。本页只放它需要查的东西：端口速查、安装失败处理、卡点表、上线前必改项。

---

## 端口与地址速查

| 服务 | 全栈 | 混合模式 | 说明 |
| --- | --- | --- | --- |
| 门户入口 | `http://localhost:3200/tokenhub/member` | `http://localhost:3000/tokenhub/member` | 必须带 `/tokenhub/member` 前缀 |
| 登录页 | `:3200/tokenhub/member/login` | `:3000/tokenhub/member/login` | |
| 成员申请 | `:3200/tokenhub/member/members` | 同左路径 | 未配凭据时显示"暂未开放" |
| 申请审核 | `:3200/tokenhub/member/members/review` | 同左 | 管理员可见 |
| 系统设置 | `:3200/tokenhub/member/settings` | 同左 | 含「成员组织」腾讯云凭据 |
| 管理员名单 | `:3200/tokenhub/member/admins` | 同左 | 与统一采买站共用 `portal_shared.admins` |
| 健康检查 | `:3200/tokenhub/member/api/health` | 同左 | 期望 `{"status":"ok","database":true}` |
| 数据库 | `127.0.0.1:5433` | 同左 | 宿主机调试用 |

改端口：`.env` 的 `PORTAL_HOST_PORT`（默认 3200）、`POSTGRES_HOST_PORT`（默认 5433）。

本仓库**没有网关、没有 nginx、没有管理台**，所以不存在 8088 / 8790 / 8789。

---

## Docker 安装失败的处理

| 平台 | 常见报错 | 处理 |
| --- | --- | --- |
| macOS | `brew: command not found` | 手动下载 dmg，或先装 Homebrew |
| macOS | `Cannot connect to the Docker daemon` | `open -a Docker`，等 60–120 秒；首次启动要接受协议 |
| macOS | 提示"应用已损坏" | 系统设置 → 隐私与安全性 → 仍要打开 |
| Windows | `winget` 不存在 | 用官网安装包 |
| Windows | 提示需要 WSL2 | 管理员 PowerShell 执行 `wsl --install`，重启后再装 |
| Windows | daemon 不启动 | BIOS 确认虚拟化已开；Hyper-V 与 WSL2 冲突时二选一 |
| Linux | `permission denied /var/run/docker.sock` | `sudo usermod -aG docker $USER` 后重新登录 |

验证：

```bash
docker info --format '{{.ServerVersion}}'
docker compose version
```

---

## 完整卡点表

| 现象 | 判断依据 | 处理 |
| --- | --- | --- |
| `/members` 显示"成员账号申请暂未开放" | 页面提示缺腾讯云凭据 | 到「设置 → 成员组织」填 SecretId/SecretKey 并点检测 |
| 检测凭据失败：`AuthFailure` | 密钥错或已禁用 | 让用户在控制台确认子账号状态，重新生成密钥 |
| 检测凭据失败：权限不足 | 子账号缺组织权限 | 授予 `QcloudOrganizationFullAccess`（或成员管理相关策略） |
| 检测通过但提交报错 | 组织根节点不存在 | 学校需先在腾讯云开通集团账号 |
| 审核通过但建号失败 | 页面显示腾讯云错误码 + RequestId | 记录原始错误码，不要盲目重试；常见是财务权限或成员数量上限 |
| 页面 404 | 访问地址少了 `/tokenhub/member` | `PORTAL_BASE_PATH` 与访问地址都要带前缀 |
| 静态资源 404 | 控制台 `/_next/...` 报错 | 同上，改完要 `--build` 重建 |
| 登录成功又跳回登录页 | 两个同名 `portal_session` | 清 Cookie；确认没混用 3000 与 3200 |
| 种子执行了但库是空的 | 查 `login_config` 全 NULL | SQL 顶部参数没填；表名必须是 `portal_shared.login_config` |
| `portal-seed` 退出码 1 | `docker compose logs portal-seed` | 通常是数据库还没就绪；确认 `portal` 已 healthy 后重跑 |
| 双站共存时互认失效 | 两站各自登录 | 两侧 `SESSION_SECRET` 必须相同，`PORTAL_COOKIE_PATH` 都必须 `/tokenhub` |

---

## 与统一采买站的差异（容易踩）

| 项 | 成员站（本仓库） | 统一采买站 |
| --- | --- | --- |
| 网关 | 无，不依赖 octafuse | 有，`gateway-proxy` + `gateway-admin` |
| 本地容器 | postgres / portal / portal-seed | 再加网关三件套与 nginx |
| 健康检查 | `{"status":"ok","database":true}` | `{"status":"ok","gateway":true}` |
| 配置来源 | 设置页优先，**env 仍作兜底**（尚未收口） | 只存数据库，env 不生效 |
| 管理员判定 | 引导账号 / 名单 / 首登认领 | 引导账号 / 名单 / 首登认领 |
| 共享数据 | `portal_shared.admins`、`app_config`、`login_config` | 同左 |

两站同时部署时用统一采买站仓库的 `deploy/docker-compose.dual.yml`，不要各自起一份。

---

## 上线前必须改的五项

| 位置 | 本地值 | 上线值 |
| --- | --- | --- |
| `.env` `PUBLIC_BASE_URL` | `http://localhost:3200/tokenhub/member` | `https://<域名>/tokenhub/member` |
| `.env` `COOKIE_SECURE` | `false` | `true` |
| `.env` `PORTAL_COOKIE_PATH` | 空 | 双站共存时填 `/tokenhub`；单站留空 |
| `deploy/init/010-login-config.sql` | 本地参数 | 换成正式域名下的地址 |
| 「设置 → 成员组织」 | 本地填的 CAM 凭据 | **换机器必须重填**：密文与 `SESSION_SECRET` 绑定，换机后旧密文解不开 |

另外把 `https://<域名>/tokenhub/member/api/auth/callback` 登记到 IdP / CAS 白名单。

完整上线流程见 [`campus-tokenhub-member-使用教程.md`](campus-tokenhub-member-使用教程.md)。
