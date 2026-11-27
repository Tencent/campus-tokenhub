/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	addApiKeyRateTokens,
	createMemoryApiKeyRateLimitStore,
	keyTokenRateLimitSubject,
	readApiKeyRateTokenUsage,
	userTokenRateLimitSubject,
	type ApiKeyRateLimitStore,
} from '@octafuse/core';
import { chargeTokenRateLimit, enforceTokenRateLimit, resolveChargedTokens } from './token-rate-limit';

const T0 = Date.parse('2026-09-05T02:31:42.123Z');

function usage(total: number, input = 0, output = 0) {
	return { total_tokens: total, input_tokens: input, output_tokens: output };
}

/** 记录 addTokens / readTokenUsage 调用的 store，用于断言短路与零调用。 */
function spyStore(seed?: { subject: string; tokens: number }) {
	const calls: { read: string[]; added: { subject: string; tokens: number }[] } = { read: [], added: [] };
	const inner = createMemoryApiKeyRateLimitStore();
	const store: ApiKeyRateLimitStore = {
		consumeCount: (subject, nowMs, limit) => inner.consumeCount(subject, nowMs, limit),
		readTokenUsage(subject, nowMs, limit) {
			calls.read.push(subject);
			return inner.readTokenUsage(subject, nowMs, limit);
		},
		addTokens(subject, nowMs, tokens) {
			calls.added.push({ subject, tokens });
			return inner.addTokens(subject, nowMs, tokens);
		},
	};
	if (seed) inner.addTokens(seed.subject, T0, seed.tokens);
	return { store, calls, inner };
}

describe('resolveChargedTokens', () => {
	it('takes the max of total_tokens and input+output', () => {
		assert.equal(resolveChargedTokens(usage(3000)), 3000);
		assert.equal(resolveChargedTokens(usage(0, 900, 100)), 1000);
		assert.equal(resolveChargedTokens(usage(5000, 900, 100)), 5000);
	});

	it('returns 0 for empty / missing / nonsense usage', () => {
		assert.equal(resolveChargedTokens(usage(0)), 0);
		assert.equal(resolveChargedTokens(null), 0);
		assert.equal(resolveChargedTokens(undefined), 0);
		assert.equal(resolveChargedTokens(usage(-5, -1, -2)), 0);
		assert.equal(resolveChargedTokens(usage(Number.NaN, 10, 5)), 15);
	});
});

describe('enforceTokenRateLimit', () => {
	it('does not touch the store when neither layer configured tpm', async () => {
		const { store, calls } = spyStore();
		assert.equal(await enforceTokenRateLimit('k1', 'u1', { rpm: 60 }, null, T0, store), null);
		assert.deepEqual(calls.read, []);
	});

	it('passes when the window is below the limit', async () => {
		const { store, calls } = spyStore({ subject: keyTokenRateLimitSubject('k1'), tokens: 400 });
		assert.equal(await enforceTokenRateLimit('k1', 'u1', { tpm: 1000 }, null, T0, store), null);
		// 用户层没配 tpm，不该被读
		assert.deepEqual(calls.read, [keyTokenRateLimitSubject('k1')]);
	});

	it('hits the key layer and stops before the user layer', async () => {
		const { store, calls } = spyStore({ subject: keyTokenRateLimitSubject('k1'), tokens: 1000 });
		const hit = await enforceTokenRateLimit('k1', 'u1', { tpm: 1000 }, { tpm: 1000 }, T0, store);
		assert.deepEqual(hit, {
			retryAfterSeconds: 60,
			subject: keyTokenRateLimitSubject('k1'),
			used: 1000,
			limit: 1000,
		});
		assert.deepEqual(calls.read, [keyTokenRateLimitSubject('k1')]);
	});

	it('hits the user layer when the key layer is clean', async () => {
		const { store } = spyStore({ subject: userTokenRateLimitSubject('u1'), tokens: 5000 });
		const hit = await enforceTokenRateLimit('k1', 'u1', { tpm: 1000 }, { tpm: 1000 }, T0, store);
		assert.equal(hit?.subject, userTokenRateLimitSubject('u1'));
		assert.equal(hit?.used, 5000);
	});

	it('treats tpm 0 as always exceeded', async () => {
		const { store } = spyStore();
		const hit = await enforceTokenRateLimit('k1', 'u1', { tpm: 0 }, null, T0, store);
		assert.equal(hit?.limit, 0);
		assert.equal(hit?.used, 0);
		assert.equal(hit?.retryAfterSeconds, 1);
	});

	it('fails open when the store throws', async () => {
		const store: ApiKeyRateLimitStore = {
			consumeCount: () => ({ count: 0, retryAfterSeconds: 1 }),
			readTokenUsage() {
				throw new Error('boom');
			},
			addTokens() {},
		};
		assert.equal(await enforceTokenRateLimit('k1', 'u1', { tpm: 1 }, null, T0, store), null);
	});
});

describe('chargeTokenRateLimit', () => {
	it('charges both layers when both configured tpm', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		await chargeTokenRateLimit('k1', 'u1', { tpm: 1000 }, { tpm: 2000 }, usage(300), T0, store);
		assert.equal((await readApiKeyRateTokenUsage(keyTokenRateLimitSubject('k1'), T0, 10_000, store)).used, 300);
		assert.equal((await readApiKeyRateTokenUsage(userTokenRateLimitSubject('u1'), T0, 10_000, store)).used, 300);
	});

	it('only touches layers that configured tpm', async () => {
		const { store, calls } = spyStore();
		await chargeTokenRateLimit('k1', 'u1', { tpm: 1000 }, null, usage(300), T0, store);
		assert.deepEqual(calls.added, [{ subject: keyTokenRateLimitSubject('k1'), tokens: 300 }]);
	});

	it('does nothing when neither layer configured tpm', async () => {
		const { store, calls } = spyStore();
		await chargeTokenRateLimit('k1', 'u1', { rpm: 60 }, null, usage(300), T0, store);
		assert.deepEqual(calls.added, []);
	});

	it('does nothing when the request produced no token', async () => {
		const { store, calls } = spyStore();
		await chargeTokenRateLimit('k1', 'u1', { tpm: 1 }, { tpm: 1 }, usage(0), T0, store);
		assert.deepEqual(calls.added, []);
	});

	it('charges both subjects with the same amount', async () => {
		const { store, calls } = spyStore();
		await chargeTokenRateLimit('k1', 'u1', { tpm: 1 }, { tpm: 1 }, usage(0, 900, 100), T0, store);
		assert.deepEqual(calls.added, [
			{ subject: keyTokenRateLimitSubject('k1'), tokens: 1000 },
			{ subject: userTokenRateLimitSubject('u1'), tokens: 1000 },
		]);
	});

	it('keeps charging the user window when the key window write fails', async () => {
		const added: string[] = [];
		const store: ApiKeyRateLimitStore = {
			consumeCount: () => ({ count: 0, retryAfterSeconds: 1 }),
			readTokenUsage: () => ({ used: 0, exceeded: false, retryAfterSeconds: 1 }),
			addTokens(subject) {
				if (subject.startsWith('kt:')) throw new Error('key window down');
				added.push(subject);
			},
		};
		await chargeTokenRateLimit('k1', 'u1', { tpm: 1 }, { tpm: 1 }, usage(10), T0, store);
		assert.deepEqual(added, [userTokenRateLimitSubject('u1')]);
	});

	it('swallows store errors so accounting can continue', async () => {
		const store: ApiKeyRateLimitStore = {
			consumeCount: () => ({ count: 0, retryAfterSeconds: 1 }),
			readTokenUsage: () => ({ used: 0, exceeded: false, retryAfterSeconds: 1 }),
			addTokens() {
				throw new Error('boom');
			},
		};
		await assert.doesNotReject(() =>
			chargeTokenRateLimit('k1', 'u1', { tpm: 1 }, { tpm: 1 }, usage(10), T0, store)
		);
	});

	it('shares one window per subject across repeated charges', async () => {
		const store = createMemoryApiKeyRateLimitStore();
		const key = keyTokenRateLimitSubject('k1');
		await addApiKeyRateTokens(key, T0, 100, store);
		await chargeTokenRateLimit('k1', 'u1', { tpm: 10_000 }, null, usage(900), T0 + 1, store);
		assert.equal((await readApiKeyRateTokenUsage(key, T0 + 2, 10_000, store)).used, 1000);
	});
});
