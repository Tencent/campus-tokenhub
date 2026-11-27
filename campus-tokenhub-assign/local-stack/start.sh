#!/bin/bash
# 本地联调一键启动（自包含，不依赖仓库外路径）
# Postgres :5433   Proxy :8790   Admin :8789   门户 :3000
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$ROOT/.." && pwd)"
GW="$ROOT/octafuse-gateway"
PGDATA="$ROOT/octafuse-pgdata"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

PG_CTL="${PG_CTL:-$(command -v pg_ctl || echo /usr/local/bin/pg_ctl)}"
PG_ISREADY="${PG_ISREADY:-$(command -v pg_isready || echo /usr/local/bin/pg_isready)}"

C_BLUE='\033[36m'; C_GREEN='\033[32m'; C_YELLOW='\033[33m'; C_RED='\033[31m'; C_OFF='\033[0m'
info() { printf "${C_BLUE}[   ..   ]${C_OFF} %s\n" "$*"; }
ok()   { printf "${C_GREEN}[   OK   ]${C_OFF} %s\n" "$*"; }
warn() { printf "${C_YELLOW}[  WARN  ]${C_OFF} %s\n" "$*"; }
fail() { printf "${C_RED}[  FAIL  ]${C_OFF} %s\n" "$*"; }

PORT_PG=5433
PORT_PROXY=8790
PORT_ADMIN=8789
PORT_PORTAL=3000

port_pid() { lsof -ti tcp:"$1" 2>/dev/null | head -1; }

# 轮询等待：$1 描述，$2 最大秒数，其后为检查命令；成功返回 0
wait_until() {
  local desc="$1" max="$2"; shift 2
  local i=0
  while [ "$i" -lt "$max" ]; do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
    if [ $((i % 5)) -eq 0 ]; then
      printf "         …已等待 %ss（%s）\n" "$i" "$desc"
    fi
  done
  return 1
}

check_pg()     { "$PG_ISREADY" -h 127.0.0.1 -p "$PORT_PG" >/dev/null 2>&1; }
check_proxy()  { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT_PROXY/health")" = "200" ]; }
check_admin()  { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT_ADMIN/")" != "000" ]; }
check_portal() { [ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://127.0.0.1:$PORT_PORTAL/login")" = "200" ]; }

PIDS=()
cleanup() {
  echo
  info "收到退出信号，正在停止本次启动的进程…"
  for pid in "${PIDS[@]:-}"; do
    [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  done
  for port in "$PORT_PORTAL" "$PORT_ADMIN" "$PORT_PROXY"; do
    pid=$(port_pid "$port")
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  info "门户与网关已停止；Postgres 仍在运行（要停请执行 ./local-stack/stop.sh）"
  exit 0
}
trap cleanup INT TERM

printf '\n=== campus-tokenhub 本地联调栈 ===\n'
info "工作目录：$ROOT"
printf '\n'

# ---------------------------------------------------------------- 1) Postgres
info "[1/4] Postgres :$PORT_PG"
if check_pg; then
  ok "已在运行，跳过启动"
else
  info "未运行，正在启动（数据目录 octafuse-pgdata）…"
  "$PG_CTL" -D "$PGDATA" \
    -o "-p $PORT_PG -k $PGDATA -c listen_addresses=127.0.0.1" \
    -l "$LOGS/postgres.log" start >/dev/null 2>&1
  if wait_until "等待 Postgres 接受连接" 20 check_pg; then
    ok "已启动"
  else
    fail "启动失败，最近日志（logs/postgres.log）："
    tail -15 "$LOGS/postgres.log" 2>/dev/null
    exit 1
  fi
fi

# ------------------------------------------------------------------- 2) Proxy
printf '\n'
info "[2/4] OctaFuse Proxy :$PORT_PROXY"
if check_proxy; then
  ok "已在运行（pid $(port_pid "$PORT_PROXY")），跳过启动"
elif [ -n "$(port_pid "$PORT_PROXY")" ]; then
  warn "端口被 pid $(port_pid "$PORT_PROXY") 占用但健康检查不通，先执行 ./local-stack/stop.sh"
  exit 1
else
  info "启动中（首次编译约 15~40s，日志 logs/proxy.log）…"
  ( cd "$GW" && exec npm run dev:proxy:node ) >>"$LOGS/proxy.log" 2>&1 &
  PIDS+=("$!")
  if wait_until "等待 proxy 健康检查通过" 90 check_proxy; then
    ok "已就绪（pid $(port_pid "$PORT_PROXY")）"
  else
    fail "90s 内未就绪，最近日志（logs/proxy.log）："
    tail -20 "$LOGS/proxy.log"
    exit 1
  fi
fi

# ------------------------------------------------------------------- 3) Admin
printf '\n'
info "[3/4] OctaFuse Admin :$PORT_ADMIN"
if check_admin; then
  ok "已在运行（pid $(port_pid "$PORT_ADMIN")），跳过启动"
elif [ -n "$(port_pid "$PORT_ADMIN")" ]; then
  warn "端口被 pid $(port_pid "$PORT_ADMIN") 占用但访问不通，先执行 ./local-stack/stop.sh"
  exit 1
else
  info "启动中（日志 logs/admin.log）…"
  ( cd "$GW/packages/admin" && exec npm run dev:node ) >>"$LOGS/admin.log" 2>&1 &
  PIDS+=("$!")
  if wait_until "等待 admin 监听端口" 90 check_admin; then
    ok "已就绪（pid $(port_pid "$PORT_ADMIN")）"
  else
    fail "90s 内未就绪，最近日志（logs/admin.log）："
    tail -20 "$LOGS/admin.log"
    exit 1
  fi
fi

# ------------------------------------------------------------------- 4) 门户
printf '\n'
info "[4/4] campus-tokenhub 门户 :$PORT_PORTAL"
if check_portal; then
  ok "已在运行（pid $(port_pid "$PORT_PORTAL")），跳过启动"
elif [ -n "$(port_pid "$PORT_PORTAL")" ]; then
  warn "端口被 pid $(port_pid "$PORT_PORTAL") 占用但访问不通，先执行 ./stop-local.sh"
  exit 1
else
  info "启动中（Next.js dev 首屏编译约 10~30s，日志 logs/portal.log）…"
  ( cd "$APP" && exec env -u NODE_OPTIONS npm run dev ) >>"$LOGS/portal.log" 2>&1 &
  PIDS+=("$!")
  if wait_until "等待门户编译完成" 120 check_portal; then
    ok "已就绪（pid $(port_pid "$PORT_PORTAL")）"
  else
    fail "120s 内未就绪，最近日志（logs/portal.log）："
    tail -20 "$LOGS/portal.log"
    exit 1
  fi
fi

# -------------------------------------------------------------------- 汇总
printf '\n=== 全部就绪 ===\n'
printf '  门户      http://localhost:%s/        → /login → 学校 SSO\n' "$PORT_PORTAL"
printf '  Admin     http://127.0.0.1:%s/   (admin/octafuse123)\n' "$PORT_ADMIN"
printf '  Proxy     http://127.0.0.1:%s/health\n' "$PORT_PROXY"
printf '  Postgres  127.0.0.1:%s        (db=octafuse, user=octafuse, 无密码)\n' "$PORT_PG"
printf '\n  日志目录：%s\n' "$LOGS"
printf '  停止：Ctrl+C，或另开终端执行 ./stop-local.sh\n\n'
info "前台挂起中（这是正常的，按 Ctrl+C 停止）…"

wait
