/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台客户端会话协调器（design D6）。
 *
 * 职责：
 * - 作为浏览器侧唯一 Cookie 变更入口（login / logout / expiry）；
 * - 用 generation 隔离旧 `auth/check` 与旧账号响应，不写回新会话；
 *   代次在意图开始时递增，因此 pending 窗口内不会把敏感 UI 重新挂回；
 * - 用同源 Web Locks 串行化同一 Cookie 边界内的变更（跨标签页）；
 * - BroadcastChannel 只传播非敏感事件（pending / invalidated / settled），不传密码、token 或账号数据；
 * - pending 时不排队密码、不自动重放；网络/解析失败标记 uncertain 并由调用方决定是否重新核对。
 *
 * 本模块不导入 React，便于单测；UI 侧通过 `useSyncExternalStore` 订阅快照。
 */
import { adminApiPath } from './admin-browser-path';
import { readApiJson } from './api-json';
import type { AdminAuthMode } from './admin-auth-mode';
import { buildSsoLoginTarget } from '../ui/sso-redirect';

export type AuthChangeKind = 'login' | 'logout' | 'expiry';
export type AuthPending = AuthChangeKind | null;
export type AuthOutcome = 'success' | 'failure' | 'uncertain' | 'busy';
/** `/api/auth/check` 明确告知的异常状态；两者都不能自动跳转门户登录。 */
export type AuthReason = 'not_admin' | 'sso_not_configured';

export interface AuthSnapshot {
	/** 会话代次：每次会话变更意图开始时递增，用于丢弃旧请求结果。 */
	generation: number;
	authenticated: boolean;
	pending: AuthPending;
	error: string | null;
	/** 最近一次会话变更意图，用于在失败后提供对应的明确重试入口。 */
	lastAction: AuthChangeKind | null;
	/** 同源锁能力：Chrome 等现代浏览器为 `web-locks`。 */
	coordination: 'web-locks' | 'unsupported';
	/** 服务端下发的登录模式（运行期 `ADMIN_AUTH_MODE`）：决定渲染 SSO 屏还是回滚用的账密表单。 */
	mode: AdminAuthMode;
	reason: AuthReason | null;
	/** 门户登录页绝对地址；由服务端从 `PORTAL_LOGIN_URL` 下发，避免构建期绑定。 */
	loginUrl: string | null;
	/** 当前身份（邮箱或共享账号名），仅用于「无管理权限」提示，不作为鉴权依据。 */
	username: string | null;
}

export interface AuthCoordinatorOptions {
	fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
	/** 测试注入：同源 Web Locks 实现。 */
	lockManager?: Pick<LockManager, 'request'> | null;
	/** 测试注入：BroadcastChannel 实现（传 null 关闭）。 */
	channel?: BroadcastChannel | null;
	/** 测试注入：整页跳转（默认 `window.location.assign`）。 */
	navigate?: (url: string) => void;
}

export interface AuthCoordinator {
	getSnapshot(): AuthSnapshot;
	subscribe(listener: () => void): () => void;
	/** 账密登录：仅 `password`/`both` 模式（回滚与应急通道）可用。 */
	login(username: string, password: string): Promise<AuthOutcome>;
	/** 门户 SSO：整页跳转，不写任何本地状态。 */
	startSsoLogin(currentPath: string): AuthOutcome;
	logout(): Promise<AuthOutcome>;
	handleExpiry(): Promise<AuthOutcome>;
	revalidate(): Promise<boolean>;
	dispose(): void;
}

/** 锁名必须跨 UI 版本稳定，并且按共享 Cookie 的同源边界生效（Web Locks 天然同源）。 */
const SESSION_LOCK_NAME = 'octafuse-admin:session';
const SESSION_CHANNEL_NAME = 'octafuse-admin:session';
/**
 * 另一标签页只广播 pending，不保证一定能广播 settled（例如标签页被关闭）。
 * 超时后本页自行解除 pending，避免 UI 永久处于 busy。
 */
const REMOTE_PENDING_TIMEOUT_MS = 20_000;
const BUSY_ERROR = 'Another session change is still in progress. Try again in a moment.';
const LOGIN_START_FAILED = 'Sign-in could not be started. Check your connection and try again.';
const LOGOUT_UNCONFIRMED = 'Sign-out could not be confirmed. Try again before leaving this device.';
const SESSION_EXPIRED = 'Session expired. Sign in again.';

type ChannelMessage =
	| { type: 'session-pending'; kind: AuthChangeKind }
	| { type: 'session-invalidated' }
	| { type: 'session-settled' };

function readError(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const message = (payload as { message?: unknown }).message;
	return typeof message === 'string' && message.trim() ? message : null;
}

export function createAdminAuthCoordinator(
	options: AuthCoordinatorOptions = {},
): AuthCoordinator {
	const lockManager =
		options.lockManager !== undefined
			? options.lockManager
			: typeof navigator !== 'undefined'
				? (navigator.locks ?? null)
				: null;

	let channel: BroadcastChannel | null = null;
	if (options.channel !== undefined) {
		channel = options.channel;
	} else if (typeof BroadcastChannel === 'function') {
		try {
			channel = new BroadcastChannel(SESSION_CHANNEL_NAME);
		} catch {
			channel = null;
		}
	}

	const fetchImpl =
		options.fetchImpl ??
		((input: string, init?: RequestInit) => fetch(adminApiPath(input), init));

	const navigate =
		options.navigate ??
		((url: string) => {
			// 服务端渲染阶段没有 window：跳转只发生在浏览器交互里
			if (typeof window !== 'undefined') window.location.assign(url);
		});

	let snapshot: AuthSnapshot = {
		generation: 0,
		authenticated: false,
		pending: null,
		error: null,
		lastAction: null,
		coordination: lockManager ? 'web-locks' : 'unsupported',
		mode: 'portal',
		reason: null,
		loginUrl: null,
		username: null,
	};
	const listeners = new Set<() => void>();

	function emit(): void {
		for (const listener of listeners) listener();
	}

	function update(patch: Partial<AuthSnapshot>): void {
		snapshot = { ...snapshot, ...patch };
		emit();
	}

	function post(message: ChannelMessage): void {
		try {
			channel?.postMessage(message);
		} catch {
			// 广播失败不影响本标签页状态。
		}
	}

	let remotePendingTimer: ReturnType<typeof setTimeout> | null = null;

	function clearRemotePendingTimer(): void {
		if (remotePendingTimer !== null) {
			clearTimeout(remotePendingTimer);
			remotePendingTimer = null;
		}
	}

	async function withLock<T>(task: () => Promise<T>): Promise<T> {
		if (!lockManager?.request) return task();
		try {
			return await lockManager.request(SESSION_LOCK_NAME, { mode: 'exclusive' }, task);
		} catch (error) {
			// 必须显式拒绝，才能让调用方复位 pending 而不是永久挂起。
			throw error instanceof Error ? error : new Error('session lock request failed');
		}
	}

	/**
	 * 开始一次会话变更意图：立刻递增代次并卸载敏感 UI，再进入锁。
	 *
	 * 代次在这里（而不是结算时）递增，才能让 pending 窗口内返回的旧 `auth/check`
	 * 与旧登录响应失效——否则登出期间旧核对结果会把已卸载的 UI 重新挂回来。
	 */
	function beginIntent(kind: AuthChangeKind): number {
		const generation = snapshot.generation + 1;
		update({ generation, pending: kind, error: null, authenticated: false, lastAction: kind });
		post({ type: 'session-pending', kind });
		return generation;
	}

	/** 真实核对服务端会话。返回 null 表示无结论（网络/解析失败，或代次已变）。 */
	async function checkSession(): Promise<boolean | null> {
		const generation = snapshot.generation;
		try {
			const response = await fetchImpl('/api/auth/check', { cache: 'no-store' });
			const payload: unknown = await response.json();
			const record = (payload ?? {}) as {
				authenticated?: unknown;
				mode?: unknown;
				reason?: unknown;
				loginUrl?: unknown;
			};
			const authenticated = typeof record.authenticated === 'boolean' ? record.authenticated : false;
			const mode: AdminAuthMode =
				record.mode === 'password' || record.mode === 'both' || record.mode === 'portal'
					? record.mode
					: snapshot.mode;
			const reason: AuthReason | null =
				record.reason === 'not_admin' || record.reason === 'sso_not_configured' ? record.reason : null;
			const loginUrl = typeof record.loginUrl === 'string' && record.loginUrl ? record.loginUrl : null;
			const usernameFromCheck = (record as { username?: unknown }).username;
			const username = typeof usernameFromCheck === 'string' && usernameFromCheck ? usernameFromCheck : null;
			if (generation !== snapshot.generation) return null;
			update({ authenticated, mode, reason, loginUrl, username });
			return authenticated;
		} catch {
			return null;
		}
	}

	async function revalidate(): Promise<boolean> {
		// 变更进行中不读也不写：此刻 Cookie 正在转换，任何结论都会与意图状态打架。
		if (snapshot.pending) return snapshot.authenticated;
		const result = await checkSession();
		// 网络/解析失败不等于未登录：保持现状，避免抖动把已登录用户闪回登录页。
		return result === null ? snapshot.authenticated : result;
	}

	/** 取锁失败或任务抛出未预期错误时，复位 pending 并给出明确错误，避免永久 busy。 */
	async function runLocked(
		task: () => Promise<AuthOutcome>,
		fallbackError: string,
	): Promise<AuthOutcome> {
		try {
			return await withLock(task);
		} catch {
			update({ pending: null, error: fallbackError });
			post({ type: 'session-settled' });
			return 'uncertain';
		}
	}

	const LOGIN_URL_MISSING = 'Sign-in is not configured. Contact your administrator.';

	/**
	 * 门户 SSO：整页跳转，**不写任何本地状态**、不发请求。
	 * `currentPath` 必须是管理台自己的站内相对路径（调用方负责裁剪公网前缀）。
	 */
	function startSsoLogin(currentPath: string): AuthOutcome {
		if (!snapshot.loginUrl) {
			update({ error: LOGIN_URL_MISSING });
			return 'failure';
		}
		try {
			navigate(buildSsoLoginTarget(snapshot.loginUrl, currentPath));
			update({ error: null });
			return 'success';
		} catch {
			update({ error: LOGIN_URL_MISSING });
			return 'failure';
		}
	}

	async function login(username: string, password: string): Promise<AuthOutcome> {
		if (snapshot.pending) {
			update({ error: BUSY_ERROR });
			return 'busy';
		}
		beginIntent('login');

		return runLocked(async () => {
			try {
				const response = await fetchImpl('/api/auth/login', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ username, password }),
				});
				const data = await readApiJson(response);
				if (data.success) {
					update({ authenticated: true, pending: null, error: null });
					post({ type: 'session-settled' });
					return 'success';
				}
				update({
					authenticated: false,
					pending: null,
					error: data.message ?? 'Sign-in failed',
				});
				post({ type: 'session-settled' });
				return 'failure';
			} catch {
				// 结果不确定：在锁内用 auth/check 核对，再决定展示哪种状态。
				const checked = await checkSession();
				update({
					authenticated: checked === true,
					pending: null,
					error: checked === true ? null : 'Sign-in could not be confirmed. Check your connection and try again.',
				});
				post({ type: 'session-settled' });
				return checked === true ? 'success' : 'uncertain';
			}
		}, LOGIN_START_FAILED);
	}

	async function logout(): Promise<AuthOutcome> {
		if (snapshot.pending) {
			update({ error: BUSY_ERROR });
			return 'busy';
		}
		// 先卸载敏感 UI，再发请求；失败也不声称 Cookie 已失效。
		beginIntent('logout');

		return runLocked(async () => {
			try {
				const response = await fetchImpl('/api/auth/logout', { method: 'POST' });
				if (!response.ok) throw new Error(`logout HTTP ${response.status}`);
				update({ authenticated: false, pending: null, error: null });
				post({ type: 'session-settled' });
				return 'success';
			} catch {
				update({
					authenticated: false,
					pending: null,
					error: LOGOUT_UNCONFIRMED,
				});
				post({ type: 'session-settled' });
				return 'uncertain';
			}
		}, LOGOUT_UNCONFIRMED);
	}

	async function handleExpiry(): Promise<AuthOutcome> {
		// 与登录共享同一 Cookie 与同一密码生命周期：变更未结算时不叠加第二次变更，
		// 否则用户看到的是「点了登录毫无反应且密码被清空」。
		if (snapshot.pending) return 'busy';
		const generation = beginIntent('expiry');

		return runLocked(async () => {
			// 取得锁后重新确认仍属于同一个会话转换，避免清掉另一标签页刚建立的新会话。
			if (snapshot.generation !== generation) {
				if (snapshot.pending === 'expiry') update({ pending: null });
				return 'busy';
			}
			try {
				await fetchImpl('/api/auth/logout', { method: 'POST' });
				update({ authenticated: false, pending: null });
				post({ type: 'session-settled' });
				return 'success';
			} catch {
				update({ authenticated: false, pending: null, error: SESSION_EXPIRED });
				post({ type: 'session-settled' });
				return 'uncertain';
			}
		}, SESSION_EXPIRED);
	}

	function onChannelMessage(event: MessageEvent<unknown>): void {
		const message = event.data as ChannelMessage | null;
		if (!message || typeof message !== 'object') return;
		if (message.type === 'session-pending') {
			// 另一标签页正在切换身份：先卸载本页敏感 UI，再阻止本页并发变更，
			// 避免在身份切换窗口内按旧身份继续发请求。
			update({ authenticated: false, pending: message.kind, error: null });
			clearRemotePendingTimer();
			remotePendingTimer = setTimeout(() => {
				remotePendingTimer = null;
				if (snapshot.pending === message.kind) update({ pending: null });
			}, REMOTE_PENDING_TIMEOUT_MS);
			return;
		}
		if (message.type === 'session-invalidated') {
			update({ authenticated: false });
			return;
		}
		if (message.type === 'session-settled') {
			clearRemotePendingTimer();
			if (snapshot.pending) update({ pending: null });
			// 通知不是鉴权真相：以 auth/check 重新建立本标签页状态。
			void revalidate();
		}
	}

	channel?.addEventListener('message', onChannelMessage as EventListener);

	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		login,
		startSsoLogin,
		logout,
		handleExpiry,
		revalidate,
		dispose() {
			clearRemotePendingTimer();
			channel?.removeEventListener('message', onChannelMessage as EventListener);
			listeners.clear();
		},
	};
}
