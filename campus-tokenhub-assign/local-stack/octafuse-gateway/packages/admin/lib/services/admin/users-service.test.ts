/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories, UserRow } from '@octafuse/core';
import { createAdminUser, updateAdminUser } from './users-service';

const USER_ID = '8c523806-1959-41eb-bfd7-8c5bd307e99a';

function baseUser(overrides: Partial<UserRow> = {}): UserRow {
	return {
		id: USER_ID,
		email: 'ops@example.com',
		budget_max: 9.9,
		budget_base: 9.9,
		budget_spent: 0,
		budget_period: 'none',
		budget_reset_at: null,
		wallet_granted: 20.5,
		wallet_spent: 17.20157,
		status: 'active',
		metadata: null,
		rate_limit: null,
		charged_cost_factors: null,
		external_system: 'soloent',
		external_user_id: USER_ID,
		created_at: '2026-08-26T12:19:56.000Z',
		updated_at: '2026-08-26T12:19:56.000Z',
		...overrides,
	};
}

function mockRepos(initial: UserRow) {
	const current: UserRow = { ...initial };
	const audits: Array<{
		eventType: string;
		reasonCode?: string | null;
		source?: string | null;
		reasonText?: string | null;
		changedFields?: string | null;
	}> = [];
	const repos = {
		users: {
			getById: async (id: string) => (id === current.id ? { ...current } : null),
			updateUserPlan: async (
				id: string,
				budget_max: number | null,
				budget_period: string,
				budget_reset_at: string | null,
				resetBudget = true,
				metadata?: string | null,
				budget_spent_override?: number | null,
				budget_base?: number | null,
				wallet_granted?: number | null,
				wallet_spent?: number | null
			) => {
				if (id !== current.id) return false;
				current.budget_max = budget_max;
				current.budget_period = budget_period;
				current.budget_reset_at = budget_reset_at;
				if (budget_spent_override !== undefined) {
					current.budget_spent = budget_spent_override ?? 0;
				} else if (resetBudget) {
					current.budget_spent = 0;
				}
				if (budget_base !== undefined) current.budget_base = budget_base ?? 0;
				if (wallet_granted !== undefined) current.wallet_granted = wallet_granted ?? 0;
				if (wallet_spent !== undefined) current.wallet_spent = wallet_spent ?? 0;
				if (metadata !== undefined) current.metadata = metadata;
				return true;
			},
		},
		userAuditLogs: {
			insertUserAuditLog: async (params: {
				eventType: string;
				reasonCode?: string | null;
				source?: string | null;
				reasonText?: string | null;
				changedFields?: string | null;
			}) => {
				audits.push(params);
			},
		},
	} as unknown as GatewayRepositories;
	return { repos, audits };
}

describe('updateAdminUser audit', () => {
	it('writes admin_patch_wallet when only wallet fields change', async () => {
		const { repos, audits } = mockRepos(baseUser());
		await updateAdminUser(
			repos,
			USER_ID,
			{ wallet_granted: 22, wallet_spent: 17.20157, reason: 'pa:gw:8c523806' },
			'admin_key:test'
		);
		assert.equal(audits.length, 1);
		assert.equal(audits[0].eventType, 'admin_adjust');
		assert.equal(audits[0].reasonCode, 'admin_patch_wallet');
		assert.equal(audits[0].source, 'admin_users');
		assert.equal(audits[0].reasonText, 'pa:gw:8c523806');
		const changed = JSON.parse(String(audits[0].changedFields ?? '[]')) as string[];
		assert.deepEqual(changed, ['wallet_granted']);
	});

	it('writes admin_patch_budget when only budget_max changes', async () => {
		const { repos, audits } = mockRepos(baseUser());
		await updateAdminUser(repos, USER_ID, { budget_max: 19.8, reason: 'raise budget' }, 'admin_key:test');
		assert.equal(audits.length, 1);
		assert.equal(audits[0].reasonCode, 'admin_patch_budget');
		const changed = JSON.parse(String(audits[0].changedFields ?? '[]')) as string[];
		assert.ok(changed.includes('budget_max'));
		assert.ok(!changed.includes('wallet_granted'));
		assert.ok(!changed.includes('wallet_spent'));
	});

	it('does not insert audit when wallet and budget values are unchanged', async () => {
		const { repos, audits } = mockRepos(baseUser());
		await updateAdminUser(
			repos,
			USER_ID,
			{ wallet_granted: 20.5, wallet_spent: 17.20157, budget_max: 9.9 },
			'admin_key:test'
		);
		assert.equal(audits.length, 0);
	});
});

// ------------------------------------------------ createAdminUser：开户时写入默认限流
function createRepos(options: { existing?: UserRow | null }) {
	const state = {
		current: options.existing ? { ...options.existing } : null,
		rateLimitWrites: [] as (string | null)[],
	};
	const repos = {
		users: {
			getByExternalPair: async () => (state.current ? { ...state.current } : null),
			createUser: async (params: {
				id: string;
				email: string;
				budgetMax: number | null;
				budgetBase: number;
				budgetSpent: number;
				budgetPeriod: string;
				budgetResetAt: string | null;
				status: string;
				metadata: string | null;
				externalSystem: string | null;
				externalUserId: string | null;
			}) => {
				state.current = baseUser({
					id: params.id,
					email: params.email,
					budget_max: params.budgetMax,
					budget_base: params.budgetBase,
					budget_spent: params.budgetSpent,
					budget_period: params.budgetPeriod as UserRow['budget_period'],
					metadata: params.metadata,
					external_system: params.externalSystem,
					external_user_id: params.externalUserId,
				});
			},
			getById: async (id: string) => (state.current?.id === id ? { ...state.current } : null),
			updateUserRateLimit: async (_id: string, json: string | null) => {
				state.rateLimitWrites.push(json);
				return true;
			},
		},
		userAuditLogs: { insertUserAuditLog: async () => {} },
	} as unknown as GatewayRepositories;
	return { repos, state };
}

describe('createAdminUser default rate limit', () => {
	const input = {
		email: 'student@example.com',
		external_system: 'school',
		external_user_id: 'sub-1',
		budget_max: 100,
		budget_period: 'monthly' as const,
	};

	it('writes rate_limit when the user is created', async () => {
		const { repos, state } = createRepos({});
		await createAdminUser(repos, { ...input, rate_limit: { rpm: 60, tpm: 200000 } }, 'admin');
		assert.deepEqual(state.rateLimitWrites, ['{"rpm":60,"tpm":200000}']);
	});

	it('ignores rate_limit when the user already exists', async () => {
		const { repos, state } = createRepos({
			existing: baseUser({ external_system: 'school', external_user_id: 'sub-1' }),
		});
		await createAdminUser(repos, { ...input, rate_limit: { rpm: 60 } }, 'admin');
		assert.deepEqual(state.rateLimitWrites, []);
	});

	it('does not touch rate_limit when the caller omits it', async () => {
		const { repos, state } = createRepos({});
		await createAdminUser(repos, input, 'admin');
		assert.deepEqual(state.rateLimitWrites, []);
	});

	it('rejects an invalid rate_limit on create', async () => {
		const { repos, state } = createRepos({});
		await assert.rejects(
			() => createAdminUser(repos, { ...input, rate_limit: { rpm: -1 } }, 'admin'),
			/rate_limit\.rpm must be a non-negative integer/
		);
		assert.deepEqual(state.rateLimitWrites, []);
	});

	it('accepts a JSON string and 0 as a valid limit', async () => {
		const { repos, state } = createRepos({});
		await createAdminUser(repos, { ...input, rate_limit: '{"tpm":0}' }, 'admin');
		assert.deepEqual(state.rateLimitWrites, ['{"tpm":0}']);
	});
});
