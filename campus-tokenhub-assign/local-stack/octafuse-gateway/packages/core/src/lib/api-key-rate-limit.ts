/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Per-key / per-user rate limit JSON (`api_keys.rate_limit`, `users.rate_limit`).
 * NULL / empty object = that layer is unlimited.
 *
 * Two independent dimensions over the same trailing 60s window:
 * - `rpm`：请求数。准入时先计数再判定（`count > rpm` 即拒），因此 `rpm: 0` 天然全拒。
 * - `tpm`：token 吞吐。请求完成后才拿到上游用量，所以准入只读窗口（`used >= tpm` 即拒）、
 *   完成后累加。`tpm: 0` 因 `0 >= 0` 天然全拒。单请求可在窗口尚未记账时穿透，属既定口径。
 *
 * Layers are independent; Key is a per-key cap, User is a shared pool.
 * Window counters are process/isolate memory (same consistency as circuit breakers);
 * swap in Redis later via `setApiKeyRateLimitStore`.
 */

import type { ApiKeyRateLimit } from '../types';

export type { ApiKeyRateLimit };

export const API_KEY_RATE_WINDOW_MS = 60_000;
export const INGRESS_HOST_MAX_LENGTH = 255;
/** 单个 subject 的 token 条目上限；超出时把最早的若干条合并，避免长窗口内存无界增长。 */
export const RATE_LIMIT_MAX_ENTRIES_PER_SUBJECT = 2_000;

const RATE_LIMIT_INVALID = 'rate_limit must be a JSON object or null';
const RATE_LIMIT_RPM_INVALID = 'rate_limit.rpm must be a non-negative integer';
const RATE_LIMIT_TPM_INVALID = 'rate_limit.tpm must be a non-negative integer';

/** 已知维度 → 非法值时的报错文案。新增维度只改这里。 */
const RATE_LIMIT_DIMENSIONS = {
	rpm: RATE_LIMIT_RPM_INVALID,
	tpm: RATE_LIMIT_TPM_INVALID,
} as const;

type RateLimitDimension = keyof typeof RATE_LIMIT_DIMENSIONS;

function isRateLimitDimension(key: string): key is RateLimitDimension {
	return Object.prototype.hasOwnProperty.call(RATE_LIMIT_DIMENSIONS, key);
}

export function resolveIngressHost(hostHeader?: string | null, requestUrl?: string): string | null {
	const fromHeader = hostHeader?.trim() ?? '';
	if (fromHeader) return fromHeader.slice(0, INGRESS_HOST_MAX_LENGTH);
	if (!requestUrl) return null;
	try {
		const host = new URL(requestUrl).host.trim();
		return host ? host.slice(0, INGRESS_HOST_MAX_LENGTH) : null;
	} catch {
		return null;
	}
}

function parseNonNegativeInt(raw: unknown): number | null {
	if (raw == null || raw === '') return null;
	if (typeof raw === 'boolean' || typeof raw === 'object') return null;
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
	return n;
}

function extractKnownRateLimit(raw: Record<string, unknown>): ApiKeyRateLimit | null {
	const out: ApiKeyRateLimit = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!isRateLimitDimension(key)) continue;
		if (value == null || value === '') continue;
		const n = parseNonNegativeInt(value);
		if (n != null) out[key] = n;
	}
	return out.rpm == null && out.tpm == null ? null : out;
}

function coerceRateLimitObject(
	raw: Record<string, unknown>
): { ok: true; value: ApiKeyRateLimit | null } | { ok: false; message: string } {
	const out: ApiKeyRateLimit = {};
	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined || value === null || value === '') continue;
		if (!isRateLimitDimension(key)) {
			return { ok: false, message: `rate_limit.${key} is not supported` };
		}
		const n = parseNonNegativeInt(value);
		if (n == null) return { ok: false, message: RATE_LIMIT_DIMENSIONS[key] };
		out[key] = n;
	}
	return { ok: true, value: out.rpm == null && out.tpm == null ? null : out };
}

/** Admin PATCH: omit vs null (unlimited) vs `{ rpm?: number, tpm?: number }`. */
export function coerceRateLimitInput(
	raw: unknown
): { ok: true; omit: true } | { ok: true; value: ApiKeyRateLimit | null } | { ok: false; message: string } {
	if (raw === undefined) return { ok: true, omit: true };
	if (raw === null || raw === '') return { ok: true, value: null };
	let obj: unknown = raw;
	if (typeof raw === 'string') {
		try {
			obj = JSON.parse(raw);
		} catch {
			return { ok: false, message: RATE_LIMIT_INVALID };
		}
	}
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
		return { ok: false, message: RATE_LIMIT_INVALID };
	}
	return coerceRateLimitObject(obj as Record<string, unknown>);
}

/** Parse `api_keys.rate_limit` TEXT JSON (or already-parsed object). Invalid JSON → unlimited. */
export function parseApiKeyRateLimit(raw: unknown): ApiKeyRateLimit | null {
	if (raw == null || raw === '') return null;
	let obj: unknown = raw;
	if (typeof obj === 'string') {
		try {
			obj = JSON.parse(obj);
		} catch {
			return null;
		}
	}
	if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
	return extractKnownRateLimit(obj as Record<string, unknown>);
}

export function serializeApiKeyRateLimit(limit: ApiKeyRateLimit | null | undefined): string | null {
	if (!limit) return null;
	// 键序固定 rpm → tpm，保证 rateLimitEquals 与审计变更判定稳定
	const out: ApiKeyRateLimit = {};
	if (limit.rpm != null) out.rpm = limit.rpm;
	if (limit.tpm != null) out.tpm = limit.tpm;
	if (out.rpm == null && out.tpm == null) return null;
	return JSON.stringify(out);
}

export function rateLimitEquals(
	a: ApiKeyRateLimit | null | undefined,
	b: ApiKeyRateLimit | null | undefined
): boolean {
	return serializeApiKeyRateLimit(a ?? null) === serializeApiKeyRateLimit(b ?? null);
}

export function rateLimitRpmOf(limit: ApiKeyRateLimit | null | undefined): number | null {
	return limit?.rpm ?? null;
}

export function rateLimitTpmOf(limit: ApiKeyRateLimit | null | undefined): number | null {
	return limit?.tpm ?? null;
}

/** After incrementing the window, `count > rpm` is exceeded. NULL rpm is never exceeded. */
export function isRateLimitExceeded(count: number, rpm: number | null | undefined): boolean {
	if (rpm == null) return false;
	return count > rpm;
}

/**
 * Token 维度：窗口内已用 `used >= tpm` 即超限。NULL tpm 永不超过；`tpm: 0` 恒超限。
 * 与 `isRateLimitExceeded` 的 `>` 差异源于时机（准入即计数 vs 事后才计数），见 design D3。
 */
export function isTokenRateLimitExceeded(used: number, tpm: number | null | undefined): boolean {
	if (tpm == null) return false;
	return used >= tpm;
}

/**
 * Seconds until a *new* consume on this subject can succeed.
 * `times` is the stored trailing-60s log (oldest first), including the request just counted.
 */
export function rateLimitRetryAfterSeconds(times: number[], rpm: number, nowMs: number): number {
	if (times.length === 0) return 1;
	if (rpm <= 0) {
		return Math.max(1, Math.ceil((times[0] + API_KEY_RATE_WINDOW_MS - nowMs) / 1000));
	}
	const numberToExpire = times.length - rpm + 1;
	if (numberToExpire <= 0) return 1;
	const t = times[numberToExpire - 1];
	if (t == null) return 1;
	return Math.max(1, Math.ceil((t + API_KEY_RATE_WINDOW_MS - nowMs) / 1000));
}

/**
 * Seconds until enough token weight expires for a new request to be admitted.
 * `rows` is the live trailing-60s window (oldest first).
 */
export function tokenRetryAfterSeconds(
	rows: { ts: number; tokens: number }[],
	tpm: number,
	nowMs: number
): number {
	if (rows.length === 0) return 1;
	const oldest = rows[0];
	if (tpm <= 0) {
		return Math.max(1, Math.ceil((oldest.ts + API_KEY_RATE_WINDOW_MS - nowMs) / 1000));
	}
	let total = 0;
	for (const row of rows) total += row.tokens;
	let released = 0;
	for (const row of rows) {
		// 放掉这一条之后窗口就低于阈值 → 该条过期即放行
		if (total - released - row.tokens < tpm) {
			return Math.max(1, Math.ceil((row.ts + API_KEY_RATE_WINDOW_MS - nowMs) / 1000));
		}
		released += row.tokens;
	}
	const newest = rows[rows.length - 1];
	return Math.max(1, Math.ceil((newest.ts + API_KEY_RATE_WINDOW_MS - nowMs) / 1000));
}

export function keyRateLimitSubject(keyId: string): string {
	return `k:${keyId}`;
}

export function userRateLimitSubject(userId: string): string {
	return `u:${userId}`;
}

/** Token 窗口与计次窗口必须用不同 subject，否则带权条目会被当成「1 次请求」。 */
export function keyTokenRateLimitSubject(keyId: string): string {
	return `kt:${keyId}`;
}

export function userTokenRateLimitSubject(userId: string): string {
	return `ut:${userId}`;
}

export type RateLimitLayer = {
	subject: string;
	/** token 窗口 subject（`kt:` / `ut:`）；缺省表示该层不计 token */
	tokenSubject?: string;
	rpm?: number | null;
	tpm?: number | null;
};

export type RateLimitConsumeResult = {
	count: number;
	retryAfterSeconds: number;
};

export type TokenUsageSnapshot = {
	used: number;
	exceeded: boolean;
	retryAfterSeconds: number;
};

export type RateLimitLayersResult = {
	exceeded: boolean;
	retryAfterSeconds: number;
	dimension: 'rpm' | 'tpm' | null;
	/** 命中时的可观测细节（命中的窗口 subject、实际用量与上限），供日志排查用 */
	hit: { subject: string; used: number; limit: number } | null;
};

/** 滑动窗条目：ts 为记录时刻，tokens 为权重（计次条目的权重恒为 0）。 */
export type RateLimitWindowEntry = { ts: number; tokens: number };

/**
 * Per-subject trailing-60s window. Default is process/isolate memory (same consistency as
 * circuit breakers). Swap in Redis later via `setApiKeyRateLimitStore`.
 * Subjects are prefixed (`k:` / `u:` 计次，`kt:` / `ut:` 计 token) so key and user UUIDs never collide.
 */
export type ApiKeyRateLimitStore = {
	/** 计入一次请求并返回窗口内请求数 */
	consumeCount(
		subject: string,
		nowMs: number,
		limit: number
	): RateLimitConsumeResult | Promise<RateLimitConsumeResult>;
	/** 只读探测：返回窗口内已用 token 与是否达到上限（不写窗口） */
	readTokenUsage(subject: string, nowMs: number, limit: number): TokenUsageSnapshot | Promise<TokenUsageSnapshot>;
	/** 事后累加真实用量，不做判定 */
	addTokens(subject: string, nowMs: number, tokens: number): void | Promise<void>;
};

/**
 * subject 数量上限（`MEMORY_RATE_LIMIT_MAX_ENTRIES`）与单 subject 的 token 条目上限
 * （`RATE_LIMIT_MAX_ENTRIES_PER_SUBJECT`）是两件事：前者管 key/user 的个数，后者管同一个
 * token 窗口内能保留多少条记账记录。计次窗口的条目数由 `rpm + 1` 天然约束，不在此限内。
 */
const MEMORY_RATE_LIMIT_MAX_ENTRIES = 50_000;

function dropExpiredEntries(rows: RateLimitWindowEntry[], nowMs: number): RateLimitWindowEntry[] {
	const cutoff = nowMs - API_KEY_RATE_WINDOW_MS;
	let i = 0;
	while (i < rows.length && rows[i].ts <= cutoff) i += 1;
	return i === 0 ? rows : rows.slice(i);
}

/** 保持按 ts 升序：正常追加即可，时钟回拨等异常路径才二分插入。 */
function appendEntry(rows: RateLimitWindowEntry[], entry: RateLimitWindowEntry): void {
	const last = rows[rows.length - 1];
	if (!last || last.ts <= entry.ts) {
		rows.push(entry);
		return;
	}
	let lo = 0;
	let hi = rows.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (rows[mid].ts <= entry.ts) lo = mid + 1;
		else hi = mid;
	}
	rows.splice(lo, 0, entry);
}

/**
 * 超出单 subject 上限时把最早的若干条合并成一条，保留 token 总和与最早时间戳。
 * 注意合并方向是「变宽松」：被折叠的后继条目原本过期更晚，合并后按最早 ts 一起过期，
 * 最多提前约一个条目跨度释放额度。属刻意的内存取舍（只在单窗口 >2000 条时触发），不是 bug。
 */
function capEntries(rows: RateLimitWindowEntry[], max: number): void {
	if (rows.length <= max) return;
	const mergeCount = rows.length - max + 1;
	let tokens = 0;
	for (let i = 0; i < mergeCount; i += 1) tokens += rows[i].tokens;
	rows.splice(0, mergeCount, { ts: rows[0].ts, tokens });
}

export function createMemoryApiKeyRateLimitStore(
	maxEntries = MEMORY_RATE_LIMIT_MAX_ENTRIES
): ApiKeyRateLimitStore {
	const windows = new Map<string, RateLimitWindowEntry[]>();

	function store(subject: string, rows: RateLimitWindowEntry[]): void {
		if (rows.length === 0) windows.delete(subject);
		else windows.set(subject, rows);
	}

	function pruneOverCapacity(subject: string, nowMs: number): void {
		if (windows.size <= maxEntries) return;
		for (const [id, row] of windows) {
			const pruned = dropExpiredEntries(row, nowMs);
			if (pruned.length === 0) windows.delete(id);
			else windows.set(id, pruned);
		}
		if (windows.size <= maxEntries) return;
		const overflow = windows.size - maxEntries;
		let dropped = 0;
		for (const id of windows.keys()) {
			if (dropped >= overflow) break;
			if (id === subject) continue;
			windows.delete(id);
			dropped += 1;
		}
	}

	return {
		consumeCount(subject, nowMs, limit) {
			const rows = dropExpiredEntries(windows.get(subject) ?? [], nowMs);
			const keepLimit = limit + 1;
			if (rows.length < keepLimit) appendEntry(rows, { ts: nowMs, tokens: 0 });
			store(subject, rows);
			pruneOverCapacity(subject, nowMs);
			return {
				count: rows.length,
				retryAfterSeconds: rateLimitRetryAfterSeconds(
					rows.map((row) => row.ts),
					limit,
					nowMs
				),
			};
		},

		readTokenUsage(subject, nowMs, limit) {
			const live = dropExpiredEntries(windows.get(subject) ?? [], nowMs);
			if (limit <= 0) {
				// tpm: 0 —— 恒超限；仍然给出真实 used，否则排查时窗口看起来永远是空的
				let total = 0;
				for (const row of live) total += row.tokens;
				const oldest = live[0];
				return {
					used: total,
					exceeded: true,
					retryAfterSeconds:
						oldest == null
							? 1
							: Math.max(1, Math.ceil((oldest.ts + API_KEY_RATE_WINDOW_MS - nowMs) / 1000)),
				};
			}
			// 未超限时必须把窗口内条目全部加完才知道（O(窗口条目数)，典型几十~几百条）；
			// 已达阈值立刻 break，让「持续被拒」的请求只付常数代价，不必再走第二趟求总和。
			let partial = 0;
			for (let i = live.length - 1; i >= 0; i -= 1) {
				partial += live[i].tokens;
				if (partial >= limit) break;
			}
			if (!isTokenRateLimitExceeded(partial, limit)) {
				return { used: partial, exceeded: false, retryAfterSeconds: 1 };
			}
			let total = 0;
			for (const row of live) total += row.tokens;
			return {
				used: total,
				exceeded: true,
				retryAfterSeconds: tokenRetryAfterSeconds(live, limit, nowMs),
			};
		},

		addTokens(subject, nowMs, tokens) {
			if (!(tokens > 0)) return;
			const rows = dropExpiredEntries(windows.get(subject) ?? [], nowMs);
			appendEntry(rows, { ts: nowMs, tokens });
			capEntries(rows, RATE_LIMIT_MAX_ENTRIES_PER_SUBJECT);
			store(subject, rows);
			pruneOverCapacity(subject, nowMs);
		},
	};
}

let defaultStore: ApiKeyRateLimitStore = createMemoryApiKeyRateLimitStore();

export function getApiKeyRateLimitStore(): ApiKeyRateLimitStore {
	return defaultStore;
}

export function setApiKeyRateLimitStore(store: ApiKeyRateLimitStore): void {
	defaultStore = store;
}

/** 计入一次请求（RPM 维度）。 */
export async function consumeApiKeyRateWindow(
	subject: string,
	nowMs: number,
	rpm: number,
	store: ApiKeyRateLimitStore = getApiKeyRateLimitStore()
): Promise<RateLimitConsumeResult> {
	return store.consumeCount(subject, nowMs, rpm);
}

/** 读取 token 窗口已用量（TPM 维度准入）。 */
export async function readApiKeyRateTokenUsage(
	subject: string,
	nowMs: number,
	tpm: number,
	store: ApiKeyRateLimitStore = getApiKeyRateLimitStore()
): Promise<TokenUsageSnapshot> {
	return store.readTokenUsage(subject, nowMs, tpm);
}

/** 事后累加真实 token 用量（TPM 维度记账）。 */
export async function addApiKeyRateTokens(
	subject: string,
	nowMs: number,
	tokens: number,
	store: ApiKeyRateLimitStore = getApiKeyRateLimitStore()
): Promise<void> {
	await store.addTokens(subject, nowMs, tokens);
}

function warnStoreFallback(scope: string, err: unknown): void {
	console.warn(
		`[Gateway RateLimit] store error in ${scope}, fail-open:`,
		err instanceof Error ? err.message : String(err)
	);
}

/**
 * 单层的判定：先 RPM 后 TPM，任一命中即返回命中信息；未命中返回 null。
 * 存储抛错按 fail-open 处理（记一次告警后视为该维度未超限）。
 */
async function judgeLayer(
	layer: RateLimitLayer,
	nowMs: number,
	store: ApiKeyRateLimitStore
): Promise<{
	dimension: 'rpm' | 'tpm';
	retryAfterSeconds: number;
	subject: string;
	used: number;
	limit: number;
} | null> {
	if (layer.rpm != null) {
		try {
			const consumed = await store.consumeCount(layer.subject, nowMs, layer.rpm);
			if (isRateLimitExceeded(consumed.count, layer.rpm)) {
				return {
					dimension: 'rpm',
					retryAfterSeconds: consumed.retryAfterSeconds,
					subject: layer.subject,
					used: consumed.count,
					limit: layer.rpm,
				};
			}
		} catch (err) {
			warnStoreFallback('consumeCount', err);
		}
	}
	if (layer.tpm != null && layer.tokenSubject) {
		try {
			const snapshot = await store.readTokenUsage(layer.tokenSubject, nowMs, layer.tpm);
			if (snapshot.exceeded) {
				return {
					dimension: 'tpm',
					retryAfterSeconds: snapshot.retryAfterSeconds,
					subject: layer.tokenSubject,
					used: snapshot.used,
					limit: layer.tpm,
				};
			}
		} catch (err) {
			warnStoreFallback('readTokenUsage', err);
		}
	}
	return null;
}

/**
 * Consume layers in order (typically Key then User). Within a layer, RPM is judged before TPM.
 * A layer whose `rpm` / `tpm` is NULL skips that dimension. If a dimension is already exceeded,
 * later dimensions and later layers are not touched.
 * `retryAfterSeconds` comes from the dimension that exceeded (1 when none did).
 *
 * 存储抛错一律 fail-open（放行 + 告警）：限流是保护措施，不应成为新的故障点。
 */
export async function consumeRateLimitLayers(
	layers: RateLimitLayer[],
	nowMs = Date.now(),
	store: ApiKeyRateLimitStore = getApiKeyRateLimitStore()
): Promise<RateLimitLayersResult> {
	for (const layer of layers) {
		const hit = await judgeLayer(layer, nowMs, store);
		if (hit) {
			return {
				exceeded: true,
				retryAfterSeconds: hit.retryAfterSeconds,
				dimension: hit.dimension,
				hit: { subject: hit.subject, used: hit.used, limit: hit.limit },
			};
		}
	}
	return { exceeded: false, retryAfterSeconds: 1, dimension: null, hit: null };
}
