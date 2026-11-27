/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 会话协调器（3.2.1 / design D6）。
 *
 * 只在这里证明状态机与串行化；真实两标签 Set-Cookie 时序在 3.2.2/4.3 的浏览器
 * 环境验证，不以 DOM/Promise 结果代替 Cookie 语义。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminAuthCoordinator } from '@/lib/admin-auth-coordinator';

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

function fakeLocks() {
	let tail: Promise<unknown> = Promise.resolve();
	const running: string[] = [];
	return {
		running,
		request(name: string, _options: { mode: string }, task: () => Promise<unknown>) {
			const run = tail.then(async () => {
				running.push(name);
				try {
					return await task();
				} finally {
					running.pop();
				}
			});
			tail = run.then(
				() => undefined,
				() => undefined,
			);
			return run;
		},
	};
}

function fakeChannelBus() {
	const endpoints = new Set<{ deliver: (data: unknown) => void }>();
	return {
		create(): BroadcastChannel {
			const listeners = new Set<(event: { data: unknown }) => void>();
			const endpoint = { deliver: (data: unknown) => listeners.forEach((l) => l({ data })) };
			endpoints.add(endpoint);
			return {
				postMessage(data: unknown) {
					for (const other of endpoints) if (other !== endpoint) other.deliver(data);
				},
				addEventListener(_type: string, listener: (event: { data: unknown }) => void) {
					listeners.add(listener);
				},
				removeEventListener(_type: string, listener: (event: { data: unknown }) => void) {
					listeners.delete(listener);
				},
				close() {
					endpoints.delete(endpoint);
				},
			} as unknown as BroadcastChannel;
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('admin auth coordinator', () => {
	it('logs in through the prefixed API and starts a new generation', async () => {
		const fetchImpl = vi.fn(async () => json({ success: true }));
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		expect(await coordinator.login('admin', 'secret')).toBe('success');
		expect(fetchImpl).toHaveBeenCalledWith(
			'/api/auth/login',
			expect.objectContaining({ method: 'POST' }),
		);
		expect(coordinator.getSnapshot()).toMatchObject({
			authenticated: true,
			pending: null,
			generation: 1,
			error: null,
		});
	});

	it('reports a rejected login without starting a session', async () => {
		const fetchImpl = vi.fn(async () => json({ success: false, message: 'Invalid credentials' }));
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		expect(await coordinator.login('admin', 'wrong')).toBe('failure');
		// 代次在意图开始时递增，因此失败也会推进一代：旧核对结果不再适用于新表单。
		expect(coordinator.getSnapshot()).toMatchObject({
			authenticated: false,
			pending: null,
			generation: 1,
			error: 'Invalid credentials',
		});
	});

	it('does not queue a conflicting operation while one is pending', async () => {
		const login = deferred<Response>();
		const fetchImpl = vi.fn(() => login.promise);
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		const first = coordinator.login('admin', 'secret');
		expect(await coordinator.login('admin', 'other')).toBe('busy');
		expect(await coordinator.logout()).toBe('busy');
		// 不能静默返回 busy：表单清空密码后必须还有可读的原因。
		expect(coordinator.getSnapshot().error).toMatch(/still in progress/i);
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		login.resolve(json({ success: true }));
		await first;
	});

	it('ignores an auth/check that resolves after logout changed the generation', async () => {
		const check = deferred<Response>();
		const fetchImpl = vi.fn(async (input: string) => {
			if (input === '/api/auth/check') return check.promise;
			return json({ success: true });
		});
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		const stale = coordinator.revalidate();
		await coordinator.logout();
		expect(coordinator.getSnapshot().authenticated).toBe(false);

		check.resolve(json({ authenticated: true }));
		await stale;
		expect(coordinator.getSnapshot().authenticated).toBe(false);
	});

	it('keeps the signed-out UI and asks for an explicit retry when logout fails', async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error('offline');
		});
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		expect(await coordinator.logout()).toBe('uncertain');
		const snapshot = coordinator.getSnapshot();
		expect(snapshot.authenticated).toBe(false);
		expect(snapshot.pending).toBe(null);
		expect(snapshot.lastAction).toBe('logout');
		expect(snapshot.error).toMatch(/could not be confirmed/i);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('reconciles an uncertain login with auth/check instead of retrying the write', async () => {
		const fetchImpl = vi.fn(async (input: string) => {
			if (input === '/api/auth/login') throw new Error('network reset');
			return json({ authenticated: true });
		});
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		expect(await coordinator.login('admin', 'secret')).toBe('success');
		expect(coordinator.getSnapshot().authenticated).toBe(true);
		expect(fetchImpl.mock.calls.map(([input]) => input)).toEqual([
			'/api/auth/login',
			'/api/auth/check',
		]);
	});

	it('serializes cookie changes through the lock when the channel is unavailable', async () => {
		// 广播不可用（如 BroadcastChannel 被禁用）时，锁是唯一防线：两个标签页仍不得
		// 同时改写同一 Cookie。广播可用时的跨页行为见后面的 pending 用例。
		const locks = fakeLocks();
		const order: string[] = [];
		const slowLogin = deferred<Response>();
		const fetchA = vi.fn(async (input: string) => {
			if (input === '/api/auth/login') {
				order.push('A:login-start');
				return slowLogin.promise;
			}
			return json({ authenticated: false });
		});
		const fetchB = vi.fn(async (input: string) => {
			if (input === '/api/auth/login') {
				order.push('B:login-start');
				return json({ success: true });
			}
			return json({ authenticated: false });
		});
		const first = createAdminAuthCoordinator({
			fetchImpl: fetchA,
			lockManager: locks as unknown as LockManager,
			channel: null,
		});
		const second = createAdminAuthCoordinator({
			fetchImpl: fetchB,
			lockManager: locks as unknown as LockManager,
			channel: null,
		});

		const a = first.login('admin', 'a');
		const b = second.login('admin', 'b');
		await Promise.resolve();
		expect(order).toEqual(['A:login-start']);
		expect(locks.running).toHaveLength(1);

		slowLogin.resolve(json({ success: true }));
		await a;
		await b;
		expect(order).toEqual(['A:login-start', 'B:login-start']);
		expect(second.getSnapshot().authenticated).toBe(true);
	});

	it('re-establishes state from auth/check after another tab settles', async () => {
		const bus = fakeChannelBus();
		const checks: string[] = [];
		const first = createAdminAuthCoordinator({
			fetchImpl: async () => json({ success: true }),
			lockManager: null,
			channel: bus.create(),
		});
		const second = createAdminAuthCoordinator({
			fetchImpl: async (input: string) => {
				if (input === '/api/auth/check') {
					checks.push(input);
					return json({ authenticated: true });
				}
				return json({ success: true });
			},
			lockManager: null,
			channel: bus.create(),
		});

		await first.logout();
		await vi.waitFor(() => expect(checks).toEqual(['/api/auth/check']));
		expect(second.getSnapshot().authenticated).toBe(true);
	});

	it('ignores an auth/check that resolves while login is pending', async () => {
		const check = deferred<Response>();
		const login = deferred<Response>();
		const fetchImpl = vi.fn(async (input: string) => {
			if (input === '/api/auth/check') return check.promise;
			return login.promise;
		});
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		const stale = coordinator.revalidate();
		const pendingLogin = coordinator.login('admin', 'secret');
		await Promise.resolve();

		check.resolve(json({ authenticated: true }));
		await stale;
		expect(coordinator.getSnapshot()).toMatchObject({ authenticated: false, pending: 'login' });

		login.resolve(json({ success: false, message: 'Invalid credentials' }));
		await pendingLogin;
		expect(coordinator.getSnapshot()).toMatchObject({
			authenticated: false,
			pending: null,
			error: 'Invalid credentials',
		});
	});

	it('keeps the current session when auth/check cannot answer', async () => {
		const fetchImpl = vi.fn(async (input: string) => {
			if (input === '/api/auth/check') throw new Error('offline');
			return json({ success: true });
		});
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		await coordinator.login('admin', 'secret');
		expect(coordinator.getSnapshot().authenticated).toBe(true);

		expect(await coordinator.revalidate()).toBe(true);
		expect(coordinator.getSnapshot()).toMatchObject({ authenticated: true, error: null });
	});

	it('resets pending when the session lock is rejected', async () => {
		const coordinator = createAdminAuthCoordinator({
			fetchImpl: vi.fn(async () => json({ success: true })),
			lockManager: {
				request: () => Promise.reject(new Error('lock denied')),
			} as unknown as LockManager,
			channel: null,
		});

		expect(await coordinator.login('admin', 'secret')).toBe('uncertain');
		expect(coordinator.getSnapshot()).toMatchObject({ pending: null, authenticated: false });
		expect(coordinator.getSnapshot().error).toMatch(/could not be started/i);
	});

	it('does not start an expiry change while a login is pending', async () => {
		const login = deferred<Response>();
		const fetchImpl = vi.fn(() => login.promise);
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		const pendingLogin = coordinator.login('admin', 'secret');
		expect(await coordinator.handleExpiry()).toBe('busy');
		expect(fetchImpl).toHaveBeenCalledTimes(1);

		login.resolve(json({ success: true }));
		await pendingLogin;
	});

	it('takes sensitive UI offline while another tab switches identity', async () => {
		const bus = fakeChannelBus();
		const slowLogin = deferred<Response>();
		const first = createAdminAuthCoordinator({
			fetchImpl: async () => slowLogin.promise,
			lockManager: null,
			channel: bus.create(),
		});
		const second = createAdminAuthCoordinator({
			fetchImpl: async (input: string) => {
				if (input === '/api/auth/check') return json({ authenticated: true });
				return json({ success: true });
			},
			lockManager: null,
			channel: bus.create(),
		});

		await second.revalidate();
		expect(second.getSnapshot().authenticated).toBe(true);

		const login = first.login('admin', 'secret');
		expect(second.getSnapshot()).toMatchObject({ authenticated: false, pending: 'login' });
		// 身份切换窗口内本页不得并发变更。
		expect(await second.logout()).toBe('busy');

		slowLogin.resolve(json({ success: true }));
		await login;
		await vi.waitFor(() => expect(second.getSnapshot().authenticated).toBe(true));
		expect(second.getSnapshot().pending).toBe(null);
	});

	it('releases a mirrored pending change that never settles', async () => {
		vi.useFakeTimers();
		try {
			const bus = fakeChannelBus();
			const first = createAdminAuthCoordinator({
				fetchImpl: async () => new Promise<Response>(() => {}),
				lockManager: null,
				channel: bus.create(),
			});
			const second = createAdminAuthCoordinator({
				fetchImpl: async () => json({ authenticated: false }),
				lockManager: null,
				channel: bus.create(),
			});

			void first.login('admin', 'secret');
			expect(second.getSnapshot().pending).toBe('login');

			await vi.advanceTimersByTimeAsync(20_000);
			expect(second.getSnapshot().pending).toBe(null);
		} finally {
			vi.useRealTimers();
		}
	});

	it('从 auth/check 取到 mode、reason 与 loginUrl', async () => {
		const fetchImpl = vi.fn(async () =>
			json({
				authenticated: false,
				mode: 'password',
				reason: 'not_admin',
				loginUrl: 'https://portal.test/tokenhub/portal/login',
			}),
		);
		const coordinator = createAdminAuthCoordinator({ fetchImpl, channel: null });

		await coordinator.revalidate();

		expect(coordinator.getSnapshot()).toMatchObject({
			mode: 'password',
			reason: 'not_admin',
			loginUrl: 'https://portal.test/tokenhub/portal/login',
		});
	});

	it('startSsoLogin 只做整页跳转：带 dest=admin 与编码后的 next，不发请求', async () => {
		const navigate = vi.fn();
		const fetchImpl = vi.fn(async () =>
			json({ authenticated: false, loginUrl: 'https://portal.test/login' }),
		);
		const coordinator = createAdminAuthCoordinator({ fetchImpl, navigate, channel: null });

		await coordinator.revalidate();
		const callsBefore = fetchImpl.mock.calls.length;

		expect(coordinator.startSsoLogin('/gateway/users/1?tab=keys#section')).toBe('success');
		expect(navigate).toHaveBeenCalledTimes(1);
		const target = new URL(navigate.mock.calls[0]![0] as string);
		expect(target.origin + target.pathname).toBe('https://portal.test/login');
		expect(target.searchParams.get('dest')).toBe('admin');
		expect(target.searchParams.get('next')).toBe('/gateway/users/1?tab=keys#section');
		expect(fetchImpl.mock.calls.length).toBe(callsBefore);
		expect(coordinator.getSnapshot().pending).toBe(null);
	});

	it('没有登录地址时 startSsoLogin 给出可读错误且不跳转', () => {
		const navigate = vi.fn();
		const coordinator = createAdminAuthCoordinator({
			fetchImpl: vi.fn(),
			navigate,
			channel: null,
		});

		expect(coordinator.startSsoLogin('/')).toBe('failure');
		expect(navigate).not.toHaveBeenCalled();
		expect(coordinator.getSnapshot().error).toMatch(/not configured/i);
	});

	it('not_admin 状态下 revalidate 不触发自动跳转', async () => {
		const navigate = vi.fn();
		const coordinator = createAdminAuthCoordinator({
			fetchImpl: async () =>
				json({
					authenticated: false,
					mode: 'portal',
					reason: 'not_admin',
					loginUrl: 'https://portal.test/login',
				}),
			navigate,
			channel: null,
		});

		expect(await coordinator.revalidate()).toBe(false);
		expect(navigate).not.toHaveBeenCalled();
		expect(coordinator.getSnapshot().reason).toBe('not_admin');
	});
});
