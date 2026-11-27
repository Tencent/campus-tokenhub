/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 账密登录失败限速。
 *
 * 管理台的 `/api/auth/login` 是公网可达的应急通道（门户 SSO 之外的账密入口），
 * 原来只有失败后延时 1 秒，没有次数限制，弱口令可被慢速爆破。这里按**来源 IP**
 * 做失败计数与短期锁定：
 *
 * - 窗口内失败达到上限 → 锁定一段时间，期间直接 429（不校验密码、不打延时）；
 * - 登录成功清零；
 * - 窗口内没有新失败则自动过期。
 *
 * 存储是**进程内 Map**：管理台当前是单实例部署，重启清零可接受（攻击者无法重启服务）。
 * 多副本部署时需要换成共享存储（Redis / DB），否则每副本各算一份。
 */

export type LoginRateLimitConfig = {
	/** 窗口内允许的失败次数，达到即锁定 */
	maxFailures: number;
	/** 统计窗口 */
	windowMs: number;
	/** 锁定时长 */
	lockMs: number;
};

export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitConfig = {
	maxFailures: 5,
	windowMs: 15 * 60_000,
	lockMs: 15 * 60_000,
};

/** 进程内最多保留多少个来源；超出先清过期、再按插入顺序淘汰，避免被海量伪造 IP 撑爆内存 */
const MAX_TRACKED_KEYS = 5000;

type Entry = {
	failures: number;
	firstFailureAt: number;
	/** 0 表示未锁定 */
	lockedUntil: number;
};

const store = new Map<string, Entry>();

export type LoginRateLimitState =
	| { allowed: true; remaining: number }
	| { allowed: false; retryAfterSeconds: number };

function isExpired(entry: Entry, now: number, config: LoginRateLimitConfig): boolean {
	if (entry.lockedUntil > 0) return entry.lockedUntil <= now;
	return now - entry.firstFailureAt > config.windowMs;
}

function prune(now: number, config: LoginRateLimitConfig): void {
	for (const [key, entry] of store) {
		if (isExpired(entry, now, config)) store.delete(key);
	}
	while (store.size > MAX_TRACKED_KEYS) {
		const oldest = store.keys().next().value;
		if (oldest === undefined) break;
		store.delete(oldest);
	}
}

function retryAfterSeconds(lockedUntil: number, now: number): number {
	return Math.max(1, Math.ceil((lockedUntil - now) / 1000));
}

/** 当前是否允许尝试；不改变计数。 */
export function checkLoginRateLimit(
	key: string,
	now: number = Date.now(),
	config: LoginRateLimitConfig = DEFAULT_LOGIN_RATE_LIMIT,
): LoginRateLimitState {
	const entry = store.get(key);
	if (!entry) return { allowed: true, remaining: config.maxFailures };
	if (isExpired(entry, now, config)) {
		store.delete(key);
		return { allowed: true, remaining: config.maxFailures };
	}
	if (entry.lockedUntil > now) {
		return { allowed: false, retryAfterSeconds: retryAfterSeconds(entry.lockedUntil, now) };
	}
	return { allowed: true, remaining: Math.max(config.maxFailures - entry.failures, 1) };
}

/** 记一次失败；达到上限时返回 `allowed:false`（后续请求会被 429）。 */
export function recordLoginFailure(
	key: string,
	now: number = Date.now(),
	config: LoginRateLimitConfig = DEFAULT_LOGIN_RATE_LIMIT,
): LoginRateLimitState {
	prune(now, config);

	const entry = store.get(key);
	if (!entry || isExpired(entry, now, config)) {
		store.set(key, { failures: 1, firstFailureAt: now, lockedUntil: 0 });
		return { allowed: true, remaining: config.maxFailures - 1 };
	}

	const failures = entry.failures + 1;
	const locked = failures >= config.maxFailures;
	const lockedUntil = locked ? now + config.lockMs : 0;
	store.set(key, { ...entry, failures, lockedUntil });

	return locked
		? { allowed: false, retryAfterSeconds: retryAfterSeconds(lockedUntil, now) }
		: { allowed: true, remaining: config.maxFailures - failures };
}

/** 登录成功：清掉该来源的失败记录。 */
export function resetLoginRateLimit(key: string): void {
	store.delete(key);
}

/** 仅测试用：清空进程内计数。 */
export function resetLoginRateLimitStore(): void {
	store.clear();
}
