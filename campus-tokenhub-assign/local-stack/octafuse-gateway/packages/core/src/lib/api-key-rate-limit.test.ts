/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	API_KEY_RATE_WINDOW_MS,
	RATE_LIMIT_MAX_ENTRIES_PER_SUBJECT,
	addApiKeyRateTokens,
	coerceRateLimitInput,
	consumeApiKeyRateWindow,
	consumeRateLimitLayers,
	createMemoryApiKeyRateLimitStore,
	isRateLimitExceeded,
	isTokenRateLimitExceeded,
	keyRateLimitSubject,
	keyTokenRateLimitSubject,
	parseApiKeyRateLimit,
	rateLimitEquals,
	rateLimitRpmOf,
	rateLimitRetryAfterSeconds,
	rateLimitTpmOf,
	readApiKeyRateTokenUsage,
	resolveIngressHost,
	serializeApiKeyRateLimit,
	userRateLimitSubject,
	userTokenRateLimitSubject,
	type RateLimitLayer,
} from './api-key-rate-limit';

const T0 = Date.parse('2026-09-05T02:31:42.123Z');
const MINUTE_BOUNDARY_BEFORE = Date.parse('2026-09-05T02:31:59.500Z');
const MINUTE_BOUNDARY_AFTER = Date.parse('2026-09-05T02:32:00.100Z');

function layersFor(kind: 'key' | 'user', rpm: number | null): RateLimitLayer[] {
	if (kind === 'key') {
		return [
			{ subject: keyRateLimitSubject('key-rolling'), rpm },
			{ subject: userRateLimitSubject('user-unused'), rpm: null },
		];
	}
	return [
		{ subject: keyRateLimitSubject('key-unlimited'), rpm: null },
		{ subject: userRateLimitSubject('user-rolling'), rpm },
	];
}

describe('api-key-rate-limit', () => {
	it('treats NULL rpm as unlimited', () => {
		assert.equal(isRateLimitExceeded(1_000, null), false);
		assert.equal(parseApiKeyRateLimit(null), null);
		assert.equal(parseApiKeyRateLimit(''), null);
		assert.equal(parseApiKeyRateLimit('{}'), null);
	});

	it('parses rate_limit JSON and ignores invalid blobs', () => {
		assert.deepEqual(parseApiKeyRateLimit('{"rpm":60}'), { rpm: 60 });
		assert.deepEqual(parseApiKeyRateLimit({ rpm: 0 }), { rpm: 0 });
		assert.equal(parseApiKeyRateLimit('not-json'), null);
		assert.equal(parseApiKeyRateLimit({ rpm: -1 }), null);
		assert.equal(parseApiKeyRateLimit({ rpm: 1.5 }), null);
		assert.deepEqual(parseApiKeyRateLimit({ rpm: 60, rpd: 10 }), { rpm: 60 });
	});

	it('serializes empty / rpm-only objects', () => {
		assert.equal(serializeApiKeyRateLimit(null), null);
		assert.equal(serializeApiKeyRateLimit({}), null);
		assert.equal(serializeApiKeyRateLimit({ rpm: 60 }), '{"rpm":60}');
		assert.equal(rateLimitEquals({ rpm: 60 }, { rpm: 60 }), true);
		assert.equal(rateLimitEquals(null, {}), true);
		assert.equal(rateLimitRpmOf({ rpm: 60 }), 60);
		assert.equal(rateLimitRpmOf(null), null);
	});

	it('parses and serializes rate_limit with both rpm and tpm', () => {
		assert.deepEqual(parseApiKeyRateLimit('{"rpm":60,"tpm":200000}'), { rpm: 60, tpm: 200000 });
		assert.deepEqual(parseApiKeyRateLimit('{"tpm":0}'), { tpm: 0 });
		assert.deepEqual(parseApiKeyRateLimit({ tpm: 5 }), { tpm: 5 });
		// 宽松解析（读库路径）：非法 tpm 只丢该键，不连累 rpm
		assert.deepEqual(parseApiKeyRateLimit({ rpm: 60, tpm: -1 }), { rpm: 60 });
		assert.deepEqual(parseApiKeyRateLimit({ rpm: 60, tpm: 1.5 }), { rpm: 60 });
		assert.deepEqual(parseApiKeyRateLimit({ rpm: 60, tpm: 'abc' }), { rpm: 60 });
		assert.equal(parseApiKeyRateLimit({ tpm: -1 }), null);

		// 序列化键序固定 rpm → tpm，保证 rateLimitEquals 稳定
		assert.equal(serializeApiKeyRateLimit({ rpm: 60, tpm: 200000 }), '{"rpm":60,"tpm":200000}');
		assert.equal(serializeApiKeyRateLimit({ tpm: 200000 }), '{"tpm":200000}');
		assert.equal(serializeApiKeyRateLimit({ rpm: 60 }), '{"rpm":60}');
		assert.equal(serializeApiKeyRateLimit({}), null);

		assert.equal(rateLimitEquals({ rpm: 1 }, { rpm: 1, tpm: 1 }), false);
		assert.equal(rateLimitEquals({ rpm: 1, tpm: 2 }, { rpm: 1, tpm: 2 }), true);
	});

	it('exposes rateLimitTpmOf as the tpm reader', () => {
		assert.equal(rateLimitTpmOf({ tpm: 200000 }), 200000);
		assert.equal(rateLimitTpmOf({ rpm: 60 }), null);
		assert.equal(rateLimitTpmOf(null), null);
		assert.equal(rateLimitTpmOf(undefined), null);
	});

	it('coerces PATCH rate_limit with tpm', () => {
		assert.deepEqual(coerceRateLimitInput({ tpm: 200000 }), { ok: true, value: { tpm: 200000 } });
		assert.deepEqual(coerceRateLimitInput({ rpm: 60, tpm: 200000 }), {
			ok: true,
			value: { rpm: 60, tpm: 200000 },
		});
		assert.deepEqual(coerceRateLimitInput('{"tpm":200000}'), { ok: true, value: { tpm: 200000 } });
		assert.deepEqual(coerceRateLimitInput({ tpm: '200000' }), { ok: true, value: { tpm: 200000 } });
		assert.deepEqual(coerceRateLimitInput({ tpm: 0 }), { ok: true, value: { tpm: 0 } });
		assert.deepEqual(coerceRateLimitInput({}), { ok: true, value: null });

		for (const tpm of [-1, 1.5, '1.5', 'abc', true, {}]) {
			assert.deepEqual(coerceRateLimitInput({ tpm }), {
				ok: false,
				message: 'rate_limit.tpm must be a non-negative integer',
			});
		}
		assert.deepEqual(coerceRateLimitInput({ tpd: 10 }), {
			ok: false,
			message: 'rate_limit.tpd is not supported',
		});
	});

	it('treats rpm 0 as denying the first increment', () => {		assert.equal(isRateLimitExceeded(1, 0), true);
		assert.equal(isRateLimitExceeded(0, 0), false);
	});

	it('exceeds only after the Nth+1 request in the window', () => {
		assert.equal(isRateLimitExceeded(10, 10), false);
		assert.equal(isRateLimitExceeded(11, 10), true);
	});

	it('computes retry-after until the next consume can succeed', () => {
		assert.equal(rateLimitRetryAfterSeconds([], 1, T0), 1);
		assert.equal(rateLimitRetryAfterSeconds([T0], 0, T0), 60);
		assert.equal(rateLimitRetryAfterSeconds([T0, T0 + 1_000], 1, T0 + 1_000), 60);
	});

	it('coerces PATCH rate_limit (omit / null / object)', () => {
		assert.deepEqual(coerceRateLimitInput(undefined), { ok: true, omit: true });
		assert.deepEqual(coerceRateLimitInput(null), { ok: true, value: null });
		assert.deepEqual(coerceRateLimitInput(''), { ok: true, value: null });
		assert.deepEqual(coerceRateLimitInput({}), { ok: true, value: null });
		assert.deepEqual(coerceRateLimitInput({ rpm: 60 }), { ok: true, value: { rpm: 60 } });
		assert.deepEqual(coerceRateLimitInput('{"rpm":60}'), { ok: true, value: { rpm: 60 } });
		assert.deepEqual(coerceRateLimitInput({ rpm: '60' }), { ok: true, value: { rpm: 60 } });
		assert.equal(coerceRateLimitInput({ rpm: -1 }).ok, false);
		assert.equal(coerceRateLimitInput({ rpm: 1.5 }).ok, false);
		assert.equal(coerceRateLimitInput({ rpm: '1.5' }).ok, false);
		assert.equal(coerceRateLimitInput({ rpd: 10 }).ok, false);
		assert.equal(coerceRateLimitInput(60).ok, false);
	});

	it('resolves ingress host from Host header, then URL', () => {
		assert.equal(resolveIngressHost('api.example.com', 'http://ignored.local/v1'), 'api.example.com');
		assert.equal(resolveIngressHost('  gateway.example.com:8787 ', ''), 'gateway.example.com:8787');
		assert.equal(resolveIngressHost(undefined, 'https://proxy.example.com:443/v1/models'), 'proxy.example.com');
		assert.equal(resolveIngressHost(null, 'not a url'), null);
	});

	it('counts in memory per subject and drops timestamps outside the trailing 60s', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		assert.equal((await consumeApiKeyRateWindow('k1', T0, 100, store)).count, 1);
		assert.equal((await consumeApiKeyRateWindow('k1', T0 + 1, 100, store)).count, 2);
		assert.equal((await consumeApiKeyRateWindow('k2', T0, 100, store)).count, 1);
		assert.equal((await consumeApiKeyRateWindow('k1', T0 + 1 + API_KEY_RATE_WINDOW_MS, 100, store)).count, 1);
	});

	it('prunes stale subjects when over capacity', async () => {
		const store = createMemoryApiKeyRateLimitStore(2);
		assert.equal((await consumeApiKeyRateWindow('a', T0, 10, store)).count, 1);
		assert.equal((await consumeApiKeyRateWindow('b', T0, 10, store)).count, 1);
		assert.equal((await consumeApiKeyRateWindow('c', T0 + API_KEY_RATE_WINDOW_MS, 10, store)).count, 1);
		assert.equal((await consumeApiKeyRateWindow('a', T0 + API_KEY_RATE_WINDOW_MS, 10, store)).count, 1);
	});

	it('does not consume the user window when the key layer is already exceeded', async () => {
		const inner = createMemoryApiKeyRateLimitStore();
		const subjects: string[] = [];
		const store = {
			consumeCount(subject: string, nowMs: number, limit: number) {
				subjects.push(subject);
				return inner.consumeCount(subject, nowMs, limit);
			},
			readTokenUsage(subject: string, nowMs: number, limit: number) {
				return inner.readTokenUsage(subject, nowMs, limit);
			},
			addTokens(subject: string, nowMs: number, tokens: number) {
				return inner.addTokens(subject, nowMs, tokens);
			},
		};
		const keyId = 'key-1';
		const userId = 'user-1';
		const layers = [
			{ subject: keyRateLimitSubject(keyId), rpm: 1 },
			{ subject: userRateLimitSubject(userId), rpm: 100 },
		];
		assert.equal((await consumeRateLimitLayers(layers, T0, store)).exceeded, false);
		assert.equal((await consumeRateLimitLayers(layers, T0 + 1, store)).exceeded, true);
		assert.deepEqual(subjects, [
			keyRateLimitSubject(keyId),
			userRateLimitSubject(userId),
			keyRateLimitSubject(keyId),
		]);
	});

	it('shares the user window across keys', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const userSubject = userRateLimitSubject('user-shared');
		const first = await consumeRateLimitLayers(
			[
				{ subject: keyRateLimitSubject('key-a'), rpm: null },
				{ subject: userSubject, rpm: 2 },
			],
			T0,
			store
		);
		const second = await consumeRateLimitLayers(
			[
				{ subject: keyRateLimitSubject('key-b'), rpm: null },
				{ subject: userSubject, rpm: 2 },
			],
			T0 + 1,
			store
		);
		const third = await consumeRateLimitLayers(
			[
				{ subject: keyRateLimitSubject('key-a'), rpm: null },
				{ subject: userSubject, rpm: 2 },
			],
			T0 + 2,
			store
		);
		assert.equal(first.exceeded, false);
		assert.equal(second.exceeded, false);
		assert.equal(third.exceeded, true);
	});

	it('reads token usage without writing the window', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const subject = keyTokenRateLimitSubject('k-read');
		assert.deepEqual(await readApiKeyRateTokenUsage(subject, T0, 1000, store), {
			used: 0,
			exceeded: false,
			retryAfterSeconds: 1,
		});
		await addApiKeyRateTokens(subject, T0, 400, store);
		const first = await readApiKeyRateTokenUsage(subject, T0 + 1, 1000, store);
		const second = await readApiKeyRateTokenUsage(subject, T0 + 1, 1000, store);
		assert.deepEqual(first, { used: 400, exceeded: false, retryAfterSeconds: 1 });
		assert.deepEqual(second, first);
	});

	it('flags tpm when used reaches the limit', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const subject = keyTokenRateLimitSubject('k-tpm');
		await addApiKeyRateTokens(subject, T0, 999, store);
		assert.equal((await readApiKeyRateTokenUsage(subject, T0, 1000, store)).exceeded, false);
		await addApiKeyRateTokens(subject, T0 + 1, 1, store);
		assert.equal((await readApiKeyRateTokenUsage(subject, T0 + 2, 1000, store)).exceeded, true);
	});

	it('treats tpm 0 as denying everything', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const subject = keyTokenRateLimitSubject('k-zero');
		const empty = await readApiKeyRateTokenUsage(subject, T0, 0, store);
		assert.equal(empty.exceeded, true);
		assert.equal(empty.retryAfterSeconds, 1);
		await addApiKeyRateTokens(subject, T0, 10, store);
		assert.equal((await readApiKeyRateTokenUsage(subject, T0 + 1_000, 0, store)).retryAfterSeconds, 59);
	});

	it('returns retry-after at the jump point where enough weight expires', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const subject = keyTokenRateLimitSubject('k-retry');
		// 最早一条 30 秒前 400 token，较新一条 10 秒前 800 token；合计 1200 / tpm 1000
		await addApiKeyRateTokens(subject, T0, 400, store);
		await addApiKeyRateTokens(subject, T0 + 20_000, 800, store);
		const snap = await readApiKeyRateTokenUsage(subject, T0 + 30_000, 1000, store);
		assert.equal(snap.used, 1200);
		assert.equal(snap.exceeded, true);
		assert.equal(snap.retryAfterSeconds, 30);
		// 放掉最早 400 后剩 800 < 1000
		assert.equal((await readApiKeyRateTokenUsage(subject, T0 + 60_000, 1000, store)).exceeded, false);
	});

	it('addTokens does not create count entries', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		await addApiKeyRateTokens(keyTokenRateLimitSubject('k-mixed'), T0, 5000, store);
		assert.equal((await consumeApiKeyRateWindow(keyRateLimitSubject('k-mixed'), T0, 10, store)).count, 1);
		assert.equal((await readApiKeyRateTokenUsage(keyTokenRateLimitSubject('k-mixed'), T0, 10, store)).used, 5000);
	});

	it('keeps token and count windows isolated per subject prefix', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		await addApiKeyRateTokens(keyTokenRateLimitSubject('same'), T0, 42, store);
		assert.equal((await readApiKeyRateTokenUsage(keyTokenRateLimitSubject('same'), T0, 100, store)).used, 42);
		assert.equal((await readApiKeyRateTokenUsage(keyTokenRateLimitSubject('other'), T0, 100, store)).used, 0);
		assert.equal((await consumeApiKeyRateWindow(keyRateLimitSubject('same'), T0, 100, store)).count, 1);
	});

	it('merges the oldest token entries when a subject exceeds the per-subject cap', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const subject = keyTokenRateLimitSubject('k-cap');
		const cap = RATE_LIMIT_MAX_ENTRIES_PER_SUBJECT;
		for (let i = 0; i <= cap; i += 1) await addApiKeyRateTokens(subject, T0 + i, 1, store);
		const snap = await readApiKeyRateTokenUsage(subject, T0 + cap + 1, 10_000_000, store);
		assert.equal(snap.used, cap + 1);
	});

	it('judges rpm before tpm inside one layer', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const keyId = 'k-order';
		// tpm 一开始就已超限；rpm 上限 1
		await addApiKeyRateTokens(keyTokenRateLimitSubject(keyId), T0, 5000, store);
		const layer = {
			subject: keyRateLimitSubject(keyId),
			tokenSubject: keyTokenRateLimitSubject(keyId),
			rpm: 1,
			tpm: 1000,
		};
		// 第 1 跳：rpm count=1 未超 → 落到 tpm，命中 tpm
		const first = await consumeRateLimitLayers([layer], T0, store);
		assert.equal(first.exceeded, true);
		assert.equal(first.dimension, 'tpm');
		// 第 2 跳：rpm count=2 > 1 → 先命中 rpm，不再看 tpm
		const second = await consumeRateLimitLayers([layer], T0 + 1, store);
		assert.equal(second.exceeded, true);
		assert.equal(second.dimension, 'rpm');
	});

	it('returns tpm dimension and stops before the user layer', async () => {
		const inner = createMemoryApiKeyRateLimitStore();
		const seen: string[] = [];
		const store = {
			consumeCount(subject: string, nowMs: number, limit: number) {
				seen.push(`c:${subject}`);
				return inner.consumeCount(subject, nowMs, limit);
			},
			readTokenUsage(subject: string, nowMs: number, limit: number) {
				seen.push(`t:${subject}`);
				return inner.readTokenUsage(subject, nowMs, limit);
			},
			addTokens(subject: string, nowMs: number, tokens: number) {
				return inner.addTokens(subject, nowMs, tokens);
			},
		};
		await addApiKeyRateTokens(keyTokenRateLimitSubject('key-h'), T0, 2000, store);
		seen.length = 0;
		const result = await consumeRateLimitLayers(
			[
				{
					subject: keyRateLimitSubject('key-h'),
					tokenSubject: keyTokenRateLimitSubject('key-h'),
					rpm: 10,
					tpm: 1000,
				},
				{
					subject: userRateLimitSubject('user-h'),
					tokenSubject: userTokenRateLimitSubject('user-h'),
					rpm: 10,
					tpm: 1000,
				},
			],
			T0 + 1,
			store
		);
		assert.equal(result.exceeded, true);
		assert.equal(result.dimension, 'tpm');
		assert.deepEqual(seen, [
			`c:${keyRateLimitSubject('key-h')}`,
			`t:${keyTokenRateLimitSubject('key-h')}`,
		]);
	});

	it('fails open when the store throws', async () => {
		const store = {
			consumeCount() {
				throw new Error('boom');
			},
			readTokenUsage() {
				throw new Error('boom');
			},
			addTokens() {
				throw new Error('boom');
			},
		};
		const result = await consumeRateLimitLayers(
			[{ subject: 'k:boom', tokenSubject: 'kt:boom', rpm: 1, tpm: 1 }],
			T0,
			store
		);
		assert.equal(result.exceeded, false);
		assert.equal(result.dimension, null);
	});

	it('never exceeds tpm when it is NULL', () => {
		assert.equal(isTokenRateLimitExceeded(1_000_000, null), false);
		assert.equal(isTokenRateLimitExceeded(0, 0), true);
		assert.equal(isTokenRateLimitExceeded(999, 1000), false);
		assert.equal(isTokenRateLimitExceeded(1000, 1000), true);
	});

	for (const kind of ['key', 'user'] as const) {
		describe(`${kind} trailing 60s window`, () => {
			it('exceeds on the rpm+1 request inside 60s', async () => {
				const store = createMemoryApiKeyRateLimitStore();
				const layers = layersFor(kind, 2);
				assert.equal((await consumeRateLimitLayers(layers, T0, store)).exceeded, false);
				assert.equal((await consumeRateLimitLayers(layers, T0 + 1, store)).exceeded, false);
				assert.equal((await consumeRateLimitLayers(layers, T0 + 2, store)).exceeded, true);
			});

			it('allows the next request once the oldest timestamp is 60s old', async () => {
				const store = createMemoryApiKeyRateLimitStore();
				const layers = layersFor(kind, 1);
				assert.equal((await consumeRateLimitLayers(layers, T0, store)).exceeded, false);
				assert.equal((await consumeRateLimitLayers(layers, T0 + API_KEY_RATE_WINDOW_MS, store)).exceeded, false);
			});

			it('does not reset at the UTC minute boundary', async () => {
				const store = createMemoryApiKeyRateLimitStore();
				const layers = layersFor(kind, 1);
				assert.equal((await consumeRateLimitLayers(layers, MINUTE_BOUNDARY_BEFORE, store)).exceeded, false);
				assert.equal((await consumeRateLimitLayers(layers, MINUTE_BOUNDARY_AFTER, store)).exceeded, true);
			});

			it('returns retry-after until a new consume can succeed', async () => {
				const store = createMemoryApiKeyRateLimitStore();
				const layers = layersFor(kind, 1);
				assert.equal((await consumeRateLimitLayers(layers, T0, store)).exceeded, false);
				const exceeded = await consumeRateLimitLayers(layers, T0 + 1_000, store);
				assert.equal(exceeded.exceeded, true);
				assert.equal(exceeded.retryAfterSeconds, 60);
				const retryAt = T0 + 1_000 + exceeded.retryAfterSeconds * 1000;
				assert.equal((await consumeRateLimitLayers(layers, retryAt, store)).exceeded, false);
			});
		});
	}
});
