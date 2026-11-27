#!/bin/bash
# 停止本地联调栈：先停网关进程，再停 Postgres
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PGDATA="$ROOT/octafuse-pgdata"
PG_CTL="${PG_CTL:-$(command -v pg_ctl || echo /usr/local/bin/pg_ctl)}"

for port in 8789 8790; do
  pid=$(lsof -ti tcp:"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill $pid 2>/dev/null && echo "stopped port $port (pid $pid)"
  fi
done

if "$PG_CTL" -D "$PGDATA" status >/dev/null 2>&1; then
  "$PG_CTL" -D "$PGDATA" stop -m fast
fi
