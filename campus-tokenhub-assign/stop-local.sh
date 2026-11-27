#!/bin/bash
# 停止全栈：门户 + 网关 + Postgres（数据保留在 docker 卷 octafuse_pgdata）
# 连数据一起清掉用：docker compose down -v
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

docker compose down
