/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户登出代理（design D6）。
 *
 * 管理台自己只持 `admin_session`；人类登录态在门户的 `portal_session` 里，
 * 所以"退出"必须顺手把门户会话也清掉，否则用户点完退出仍处于登录态（下次访问秒回）。
 *
 * 边界：
 * - 门户登出是 `POST`（门户明确只接受 POST），因此这里服务端转发；
 * - 只透传门户返回的 `Set-Cookie`，不复制其他响应头；
 * - 超时/5xx 一律 `ok:false`：调用方不得声称"已退出"。
 */
export const DEFAULT_LOGOUT_TIMEOUT_MS = 5000;

export type PortalLogoutResult =
	| { ok: true; skipped?: boolean; setCookies: string[] }
	| { ok: false; message: string };

export type PortalLogoutInput = {
	logoutUrl?: string;
	cookieHeader?: string | null;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
};

function readSetCookies(response: Response): string[] {
	const header = response.headers as Headers & { getSetCookie?: () => string[] };
	if (typeof header.getSetCookie === 'function') return header.getSetCookie();
	const single = response.headers.get('set-cookie');
	return single ? [single] : [];
}

export async function proxyPortalLogout(input: PortalLogoutInput): Promise<PortalLogoutResult> {
	const logoutUrl = (input.logoutUrl ?? '').trim();
	if (!logoutUrl) return { ok: true, skipped: true, setCookies: [] };

	const fetchImpl = input.fetchImpl ?? fetch;
	const timeoutMs = input.timeoutMs ?? DEFAULT_LOGOUT_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetchImpl(logoutUrl, {
			method: 'POST',
			headers: {
				...(input.cookieHeader ? { cookie: input.cookieHeader } : {}),
				accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
			},
			// 门户登出会 303 回登录页：不让 fetch 跟随，否则拿不到 Set-Cookie
			redirect: 'manual',
			signal: controller.signal,
			cache: 'no-store',
		});

		// `redirect: 'manual'` 下门户的 303 属正常结果（Set-Cookie 就在这个响应上）；
		// 浏览器环境的 opaque-redirect 状态为 0，同样视为已送达。
		const acceptable =
			response.status === 0 || (response.status >= 200 && response.status < 400);
		if (!acceptable) {
			return { ok: false, message: `门户登出失败（HTTP ${response.status}）` };
		}

		return { ok: true, setCookies: readSetCookies(response) };
	} catch (error) {
		const detail = error instanceof Error && error.name === 'AbortError' ? '超时' : '网络错误';
		return { ok: false, message: `门户登出${detail}，请稍后重试` };
	} finally {
		clearTimeout(timer);
	}
}
