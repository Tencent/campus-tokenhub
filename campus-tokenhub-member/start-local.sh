#!/bin/bash
# 本地联调一键启动：docker compose 拉起 Postgres + OctaFuse（migrate/proxy/admin）+ 门户
# 实际编排见根目录 docker-compose.yml。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if ! docker compose version >/dev/null 2>&1; then
  echo "未找到 docker compose（需要 Docker Compose v2.20+）" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker 守护进程未运行：请先启动 Docker Desktop / colima（例如 colima start）" >&2
  exit 1
fi

host_port() {
  # 取 compose 里某个服务映射到宿主机的端口，失败时回退到 $2
  local mapped
  mapped="$(docker compose port "$1" "$3" 2>/dev/null | head -1 || true)"
  echo "${mapped##*:}" | grep -E '^[0-9]+$' || echo "$2"
}

echo "=== campus-tokenhub 全栈（docker compose）==="
docker compose up -d --build

PORTAL_PORT="$(host_port portal 3000 3000)"
PROXY_PORT="$(host_port gateway-proxy 8790 8787)"
ADMIN_PORT="$(host_port gateway-admin 8789 8789)"
PG_PORT="$(host_port postgres 5433 5432)"

echo
echo "等待门户就绪（首次构建后首次启动约 10~30s）…"
for _ in $(seq 1 90); do
  if curl -fsS -m 2 -o /dev/null "http://127.0.0.1:${PORTAL_PORT}/api/health"; then
    ready=1
    break
  fi
  sleep 2
done
if [ "${ready:-0}" != "1" ]; then
  echo "门户 180s 内未就绪，最近日志：" >&2
  docker compose logs --tail 30 portal >&2
  exit 1
fi

docker compose ps

cat <<EOF

=== 全部就绪 ===
  门户      http://localhost:${PORTAL_PORT}/
  Admin     http://127.0.0.1:${ADMIN_PORT}/   (admin / octafuse123)
  Proxy     http://127.0.0.1:${PROXY_PORT}/health
  Postgres  127.0.0.1:${PG_PORT}          (db=octafuse, user=octafuse)

  日志：docker compose logs -f
  停止：./stop-local.sh

EOF
