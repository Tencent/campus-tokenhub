/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
	DEFAULT_LOGIN_RATE_LIMIT,
	checkLoginRateLimit,
	recordLoginFailure,
	resetLoginRateLimit,
	resetLoginRateLimitStore,
} from './login-rate-limit';

const T0 = 1_700_000_000_000;
const { maxFailures, windowMs, lockMs } = DEFAULT_LOGIN_RATE_LIMIT;

beforeEach(() => {
	resetLoginRateLimitStore();
});

test('前 4 次失败仍然放行，第 5 次触发锁定', () => {
	for (let index = 1; index < maxFailures; index += 1) {
		const state = recordLoginFailure('ip-1', T0 + index);
		assert.equal(state.allowed, true);
	}
	const locked = recordLoginFailure('ip-1', T0 + maxFailures);
	assert.equal(locked.allowed, false);
});

test('锁定期间 check 返回可重试秒数，到期后恢复', () => {
	for (let index = 1; index <= maxFailures; index += 1) recordLoginFailure('ip-1', T0);

	const blocked = checkLoginRateLimit('ip-1', T0 + 1000);
	assert.equal(blocked.allowed, false);
	if (!blocked.allowed) {
		assert.ok(blocked.retryAfterSeconds > 0);
		assert.ok(blocked.retryAfterSeconds <= lockMs / 1000);
	}

	const restored = checkLoginRateLimit('ip-1', T0 + lockMs + 1);
	assert.equal(restored.allowed, true);
	if (restored.allowed) assert.equal(restored.remaining, maxFailures);
});

test('窗口内没有攒够失败会自动过期，不进入锁定', () => {
	for (let index = 0; index < maxFailures - 1; index += 1) {
		recordLoginFailure('ip-1', T0 + index);
	}

	const afterWindow = checkLoginRateLimit('ip-1', T0 + windowMs + 10);
	assert.equal(afterWindow.allowed, true);
	if (afterWindow.allowed) assert.equal(afterWindow.remaining, maxFailures);
});

test('登录成功清零该来源的失败记录', () => {
	recordLoginFailure('ip-1', T0);
	recordLoginFailure('ip-1', T0 + 1);
	resetLoginRateLimit('ip-1');

	const state = checkLoginRateLimit('ip-1', T0 + 2);
	assert.equal(state.allowed, true);
	if (state.allowed) assert.equal(state.remaining, maxFailures);
});

test('不同来源互不影响', () => {
	for (let index = 1; index <= maxFailures; index += 1) recordLoginFailure('ip-1', T0 + index);

	const other = checkLoginRateLimit('ip-2', T0 + maxFailures + 1);
	assert.equal(other.allowed, true);
});

test('锁定期间重复 check 不会延长锁定', () => {
	for (let index = 1; index <= maxFailures; index += 1) recordLoginFailure('ip-1', T0);

	checkLoginRateLimit('ip-1', T0 + lockMs / 2);
	const restored = checkLoginRateLimit('ip-1', T0 + lockMs + 1);
	assert.equal(restored.allowed, true);
});
