# OctaFuse Gateway 生产部署教程（Linux 服务器 / Docker Compose）

> 适用版本：octafuse-gateway v2.18.0（以官方仓库为准，部署时建议锁版本）
> 形态：单台 Linux 服务器 + Docker 原生运行（无需 Colima / 桌面环境）

---

## 一、是什么 & 为什么这么部署

OctaFuse Gateway 是一个**自托管开源 AI 能力网关 + 运营控制面**（AGPLv3），统一接入 LLM / 图像 / 语音 / Agent Tools，提供三本账计费、按 key 限频与用量、价格/对话记录/统计看板，以及建 key、建用户的 API。

本文采用官方 `docker/compose/quickstart.yml` 的**一体化部署**，一条命令拉起四个角色：

| 角色 | 镜像 | 作用 | 容器内端口 |
|---|---|---|---|
| `postgres` | postgres:16-alpine | 元数据库（用户/key/路由/用量/账单） | 5432 |
| `migrate` | 本地构建（Dockerfile.migrate） | 一次性执行数据库迁移后退出 | — |
| `gateway-proxy` | 本地构建（Dockerfile.proxy） | **对外推理入口**，OpenAI 兼容协议 | 8787 |
| `gateway-admin` | 本地构建（Dockerfile.admin） | **管理后台 + /api/admin/** | 8789 |

---

## 二、环境要求

- **OS**：x86_64 / arm64 的 Linux（Ubuntu 22.04+、Debian 12+、CentOS Stream 9 等）
- **Docker Engine ≥ 20.10**，**Docker Compose v2.20+**（用 `docker compose` 子命令，不是旧版 `docker-compose`）
- **内存**：**构建 admin 镜像约需 4GB**（Next.js 类型检查阶段易 OOM，我们在 2GB 环境实测必崩）；运行期 2GB 即够。服务器 <4GB 请加 swap，或改用预构建镜像（见第九节）
- **磁盘**：≥10GB（镜像 + Postgres 数据卷）
- **出网**：构建时要拉取 `node:22-alpine` 与 npm 依赖
- **端口**：默认 proxy 8787、admin 8789、postgres 5432（宿主机映射可改，见第四节）

### 安装 Docker（如未装）
```bash
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker

# 允许当前用户免 sudo 操作（可选，需重新登录生效）
sudo usermod -aG docker $USER
```

---

## 三、获取代码

```bash
git clone --depth 1 --branch v2.18.0 https://github.com/OctaFuse/octafuse-gateway.git
cd octafuse-gateway
```

> 建议锁定版本（上面用 `v2.18.0`）。升级时 `git pull` 后重建镜像即可（见第八节）。

---

## 四、配置（改两处，都在 `docker/compose/quickstart.yml`）

### 1. 管理台密码（必须改，默认是 `changeme`）
找到 `gateway-admin` 服务下的：
```yaml
      ADMIN_PASSWORD: "changeme"
```
改成你的强密码：
```yaml
      ADMIN_PASSWORD: "Y0urStr0ng@Pass"
```

### 2.（可选）改宿主机端口，避免与已有服务冲突
在启动命令里用环境变量覆盖，**无需改文件**：
- `GATEWAY_PROXY_HOST_PORT` → proxy 宿主机端口（默认 `8787`）
- `GATEWAY_ADMIN_HOST_PORT` → admin 宿主机端口（默认 `8789`）
- `POSTGRES_HOST_PORT` → postgres 宿主机端口（默认 `5432`）

例如想让 proxy 走 `8790`、admin 走 `8789`：
```bash
GATEWAY_PROXY_HOST_PORT=8790 GATEWAY_ADMIN_HOST_PORT=8789 \
  docker compose -f docker/compose/quickstart.yml up -d --build
```

> `DATABASE_URL` 等由 compose 网络在容器内部自动注入，无需手动填。

---

## 五、启动

```bash
# 构建并后台启动（首次会构建三个镜像，约几分钟）
GATEWAY_PROXY_HOST_PORT=8790 GATEWAY_ADMIN_HOST_PORT=8789 \
  docker compose -f docker/compose/quickstart.yml up -d --build
```

- 不指定 `GATEWAY_*_HOST_PORT` 则用默认 `8787 / 8789`。
- 看日志：`docker compose -f docker/compose/quickstart.yml logs -f`
- 看状态：`docker compose -f docker/compose/quickstart.yml ps`

**启动顺序**：postgres 健康 → migrate 执行 35 个迁移并退出 → proxy / admin 启动。

---

## 六、验证

```bash
# 代理健康检查（应返回 200）
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8790/health

# 管理台首页（/ 会 307 跳转到 /dashboard，跟随后 200）
curl -sL -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8789/dashboard
```

浏览器访问 `http://<服务器IP>:8789/`，用 `admin` / 你设的密码登录。

> 注：本文聚焦「IP:端口」直接访问。公网生产若需加密凭据传输，应自行在前面叠加反向代理与 TLS（本文不展开）。

---

## 七、配置上游供应商（才能真发对话）

登录管理台后：

1. **上游供应商（Providers）**：添加腾讯云 / 阿里云 / 火山云 / OpenAI 等，填入对应 API Key。
2. **模型路由（Model Routes）**：把供应商的真实模型映射成你对外暴露的模型名。
3. **用户 / Key**：在「用户」里建用户、建 API Key（对应你需求里的「建 key / 建用户 API」）。
4. 之后用 proxy 入口调用：
   ```bash
   curl http://<服务器IP>:8790/v1/chat/completions \
     -H "Authorization: Bearer <管理台创建的 key>" \
     -H "Content-Type: application/json" \
     -d '{"model":"<你配置的模型名>","messages":[{"role":"user","content":"你好"}]}'
   ```

---

## 八、日常运维

```bash
cd octafuse-gateway

# 停止
docker compose -f docker/compose/quickstart.yml down

# 启动（不重建镜像，秒起）
docker compose -f docker/compose/quickstart.yml up -d

# 看某服务日志
docker compose -f docker/compose/quickstart.yml logs -f gateway-proxy

# 重启单个服务
docker compose -f docker/compose/quickstart.yml restart gateway-admin
```

### 升级
```bash
cd octafuse-gateway
git pull
GATEWAY_PROXY_HOST_PORT=8790 GATEWAY_ADMIN_HOST_PORT=8789 \
  docker compose -f docker/compose/quickstart.yml up -d --build

# 若数据库结构有变更，单独重跑迁移（幂等，可安全重跑）：
docker compose -f docker/compose/quickstart.yml run --rm migrate
```

---

## 九、排错

- **构建 admin 时 BuildKit 报 `EOF` / 容器 OOM 退出**：服务器内存不足（2GB 环境必现）。解决：≥4GB 内存或加 swap；或改用预构建镜像（见下）。
- **proxy / admin `curl` 返回 `000`、端口无监听**：先用 `docker compose ps` 确认状态为 `healthy`；再查宿主机防火墙是否放行端口；并确认访问的端口与 `GATEWAY_*_HOST_PORT` 一致。
- **登录失败**：确认 `ADMIN_PASSWORD` 已改且 admin 服务已重启。
- **迁移报错**：`docker compose ... logs migrate` 看详情；迁移幂等，可安全重跑。

### （可选）用预构建镜像，免服务器编译
官方 CI 会把镜像推到 GHCR：`ghcr.io/octafuse/octafuse-gateway-{proxy,admin,migrate}`。若公开可用，可改用 `docker/examples/gateway.compose.yml` + `.env`（填入 `GATEWAY_PROXY_IMAGE` / `GATEWAY_ADMIN_IMAGE` / `GATEWAY_MIGRATE_IMAGE` 与 `DATABASE_URL`）来跑，省去 `next build`，但需**自备 Postgres** 实例。

---

## 附：最小落地命令清单（复制即用）

```bash
# 1. 装 Docker（Ubuntu/Debian，已装可跳过）
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-plugin
sudo systemctl enable --now docker

# 2. 取代码
git clone --depth 1 --branch v2.18.0 https://github.com/OctaFuse/octafuse-gateway.git
cd octafuse-gateway

# 3. 改管理台密码（把 changeme 换成你的密码）
sed -i 's/ADMIN_PASSWORD: "changeme"/ADMIN_PASSWORD: "Y0urStr0ng@Pass"/' docker/compose/quickstart.yml

# 4. 启动（proxy 走 8790，admin 走 8789）
GATEWAY_PROXY_HOST_PORT=8790 GATEWAY_ADMIN_HOST_PORT=8789 \
  docker compose -f docker/compose/quickstart.yml up -d --build

# 5. 验证
curl -s -o /dev/null -w "proxy:%{http_code}\n" http://127.0.0.1:8790/health
curl -sL -o /dev/null -w "admin:%{http_code}\n" http://127.0.0.1:8789/dashboard
```
