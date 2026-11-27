#!/bin/sh
# Modified by the campus-tokenhub project (Tencent), 2026-11-24.
# This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.

# proxy / admin 常驻镜像入口：AUTO_MIGRATE 为真时先跑迁移再 exec CMD；默认跳过迁移。

set -eu

MIGRATE_CLI="/app/packages/core/dist/migrate/cli.js"

_is_truthy() {
	case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
		1|true|yes|on) return 0 ;;
		*) return 1 ;;
	esac
}

_run_migrate() {
	_driver="$1"
	if ! node "$MIGRATE_CLI" --driver "$_driver"; then
		echo "[docker-entrypoint:app] ERROR: migrate CLI exited non-zero" >&2
		exit 1
	fi
	echo "[docker-entrypoint:app] MIGRATE_DONE"
}

if _is_truthy "${AUTO_MIGRATE:-}"; then
	if [ -z "${DATABASE_URL:-}" ]; then
		echo "[docker-entrypoint:app] ERROR: AUTO_MIGRATE is set but DATABASE_URL is required" >&2
		exit 1
	fi

	if [ ! -f "$MIGRATE_CLI" ]; then
		echo "[docker-entrypoint:app] ERROR: migrate CLI missing at ${MIGRATE_CLI}" >&2
		exit 1
	fi

	_eff="$(printf '%s' "${DATABASE_DRIVER:-}" | tr '[:upper:]' '[:lower:]')"
	case "$_eff" in
		""|postgres|postgresql|pg)
			echo "[docker-entrypoint:app] AUTO_MIGRATE: DATABASE_DRIVER=postgres (default)"
			_run_migrate postgres
			;;
		mysql|mysql2)
			export DATABASE_DRIVER="${DATABASE_DRIVER:-mysql}"
			echo "[docker-entrypoint:app] AUTO_MIGRATE: DATABASE_DRIVER=${DATABASE_DRIVER}"
			_run_migrate mysql
			;;
		*)
			echo "[docker-entrypoint:app] ERROR: unsupported DATABASE_DRIVER='${DATABASE_DRIVER:-}'" >&2
			exit 1
			;;
	esac
fi

# 管理台镜像自检：前端产物里的前缀必须与运行期 ADMIN_UI_PUBLIC_PATH 一致。
# 不一致说明镜像没按当前前缀重建，nginx 剥前缀后浏览器会去根路径取资源（白屏）。
_check_ui_prefix() {
	_ui_version="/app/packages/admin/ui-dist/ui-version.json"
	[ -f "$_ui_version" ] || return 0
	_built="$(node -e "process.stdout.write(require('${_ui_version}').publicPath || '')")"
	_expected="$(printf '%s' "${ADMIN_UI_PUBLIC_PATH:-}" | sed 's:/*$::')"
	if [ "$_built" != "$_expected" ]; then
		echo "[docker-entrypoint:app] ERROR: admin UI was built with prefix '${_built}' but ADMIN_UI_PUBLIC_PATH is '${_expected}'" >&2
		echo "[docker-entrypoint:app] Rebuild the image with the same ADMIN_UI_PUBLIC_PATH (docker compose build gateway-admin), or leave it empty for a root deployment." >&2
		exit 1
	fi
}

_check_ui_prefix

exec "$@"
