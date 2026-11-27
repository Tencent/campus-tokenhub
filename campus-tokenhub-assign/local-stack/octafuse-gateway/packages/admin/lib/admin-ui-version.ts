/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * UI 构建版本核对（design D5）。
 *
 * Node 以根路径 `/ui-version.json`（no-store）提供非敏感 build ID；浏览器在资源加载
 * 失败时用它做一次有界核对，判断是「已发布新版本」还是仅资源下载失败。
 * 只读取 build ID，不含任何业务数据或凭证。
 */
import { joinAdminPublicPath } from './admin-public-path';

export type AdminUiVersionStatus = 'same' | 'changed' | 'unknown';

export interface AdminUiVersionResult {
	status: AdminUiVersionStatus;
	currentBuildId: string;
	remoteBuildId?: string;
}

export interface CheckAdminUiVersionOptions {
	/** 入口内嵌的 build ID（构建期注入）。 */
	currentBuildId: string;
	/** 公网前缀，根部署传空串。 */
	base?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 3000;

export function adminUiVersionPath(base = ''): string {
	return joinAdminPublicPath(base, '/ui-version.json');
}

/**
 * 单次、有界地核对远程 build ID。
 * - 网络/解析失败、非 200、缺少 buildId → `unknown`（不得据此宣称版本变化）；
 * - 与本地一致 → `same`；不一致 → `changed`。
 */
export async function checkAdminUiVersion(
	options: CheckAdminUiVersionOptions,
): Promise<AdminUiVersionResult> {
	const { currentBuildId, base = '', timeoutMs = DEFAULT_TIMEOUT_MS } = options;
	const doFetch = options.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
	if (!doFetch) return { status: 'unknown', currentBuildId };

	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const timer = controller
		? setTimeout(() => {
				controller.abort();
			}, timeoutMs)
		: null;

	try {
		const response = await doFetch(adminUiVersionPath(base), {
			cache: 'no-store',
			headers: { Accept: 'application/json' },
			...(controller ? { signal: controller.signal } : {}),
		});
		if (!response.ok) return { status: 'unknown', currentBuildId };
		const payload: unknown = await response.json();
		const remoteBuildId =
			typeof (payload as { buildId?: unknown })?.buildId === 'string'
				? (payload as { buildId: string }).buildId
				: undefined;
		if (!remoteBuildId) return { status: 'unknown', currentBuildId };
		return {
			status: remoteBuildId === currentBuildId ? 'same' : 'changed',
			currentBuildId,
			remoteBuildId,
		};
	} catch {
		return { status: 'unknown', currentBuildId };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
