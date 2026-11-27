/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * TPM（token 吞吐）维度的准入与记账。
 *
 * 为什么准入在这里而不是 `requireApiKey` 中间件：
 * - `requireApiKey` 挂在所有 `/v1/*` 入口上，而 TPM 只对具备统一「输入 + 输出 token」语义的
 *   5 个入口生效。**同一路径下会按模型分流到不同 handler**（如 Gemini `/v1beta/models/{m}:generateContent`
 *   在图片模型上走 `forwardGeminiImageGeneration`，只计图片用量、从不写 token 窗口）。
 *   中间件只能按路径匹配，无法区分 handler，会把图片入口一起卡住。
 * - `runProxyPipeline` 天然只服务这 5 个入口，无需路径判断。
 *
 * 代价（已在 design 与用户文档写明）：判定顺序是 `Key RPM → User RPM → Key TPM → User TPM`，
 * 被 TPM 拒掉的请求已经计入 rpm 窗口；每分钟的计数，无实际损失。
 *
 * token 只有在请求完成后才拿得到，所以准入是「只读探测」、记账在请求结束后补写：
 * 窗口内已用 `used >= tpm` 即拒，因此**单个（或同时在途的）请求可能穿透** —— TPM 是吞吐闸门，
 * 不是硬配额；请求数由 rpm 兜底。
 */
import type { ApiKeyRateLimit } from '@octafuse/core';
import {
	addApiKeyRateTokens,
	consumeRateLimitLayers,
	keyTokenRateLimitSubject,
	rateLimitTpmOf,
	userTokenRateLimitSubject,
	type ApiKeyRateLimitStore,
	getApiKeyRateLimitStore,
} from '@octafuse/core';
import type { UsageFromStream } from './proxy';

/** 命中 TPM 时的判定结果；未命中返回 null。 */
export type TokenRateLimitHit = {
	retryAfterSeconds: number;
	subject: string;
	used: number;
	limit: number;
};

function nonNegativeInt(raw: unknown): number {
	const n = typeof raw === 'number' ? raw : Number(raw);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return Math.trunc(n);
}

/** 本次请求应计入 TPM 窗口的 token 数。 */
export function resolveChargedTokens(
	usage: Pick<UsageFromStream, 'total_tokens' | 'input_tokens' | 'output_tokens'> | null | undefined
): number {
	if (!usage) return 0;
	const total = nonNegativeInt(usage.total_tokens);
	const inputOutput = nonNegativeInt(usage.input_tokens) + nonNegativeInt(usage.output_tokens);
	return Math.max(total, inputOutput, 0);
}

/**
 * 准入：读 Key / 用户的 token 窗口，`used >= tpm` 即命中。
 * 两层都没配 `tpm` 时直接返回 null（连 store 都不读）。
 */
export async function enforceTokenRateLimit(
	keyId: string,
	userId: string,
	keyRateLimit: ApiKeyRateLimit | null | undefined,
	userRateLimit: ApiKeyRateLimit | null | undefined,
	nowMs = Date.now(),
	store: ApiKeyRateLimitStore = getApiKeyRateLimitStore()
): Promise<TokenRateLimitHit | null> {
	const keyTpm = rateLimitTpmOf(keyRateLimit);
	const userTpm = rateLimitTpmOf(userRateLimit);
	if (keyTpm == null && userTpm == null) return null;
	const keySubject = keyTokenRateLimitSubject(keyId);
	const userSubject = userTokenRateLimitSubject(userId);
	const { exceeded, retryAfterSeconds, hit } = await consumeRateLimitLayers(
		[
			// `rpm: null` 表示这一轮只判 token 维度；subject 与 tokenSubject 同值仅为满足类型
			{ subject: keySubject, tokenSubject: keySubject, rpm: null, tpm: keyTpm },
			{ subject: userSubject, tokenSubject: userSubject, rpm: null, tpm: userTpm },
		],
		nowMs,
		store
	);
	if (!exceeded) return null;
	return {
		retryAfterSeconds,
		subject: hit?.subject ?? '-',
		used: hit?.used ?? 0,
		limit: hit?.limit ?? 0,
	};
}

/**
 * 事后记账：把本次请求的 token 累加进 Key / 用户的 token 窗口。
 * 只在该层配了 `tpm` 时才累加（没配的层不维护窗口）。
 * 每个 subject 单独 try/catch：一个窗口写失败不该连带丢掉另一个窗口的用量。
 */
export async function chargeTokenRateLimit(
	keyId: string,
	userId: string,
	keyRateLimit: ApiKeyRateLimit | null | undefined,
	userRateLimit: ApiKeyRateLimit | null | undefined,
	usage: Pick<UsageFromStream, 'total_tokens' | 'input_tokens' | 'output_tokens'> | null | undefined,
	nowMs = Date.now(),
	store: ApiKeyRateLimitStore = getApiKeyRateLimitStore()
): Promise<void> {
	const tokens = resolveChargedTokens(usage);
	if (tokens <= 0) return;
	const targets = [
		{ subject: keyTokenRateLimitSubject(keyId), tpm: rateLimitTpmOf(keyRateLimit) },
		{ subject: userTokenRateLimitSubject(userId), tpm: rateLimitTpmOf(userRateLimit) },
	].filter((target) => target.tpm != null);
	for (const target of targets) {
		try {
			await addApiKeyRateTokens(target.subject, nowMs, tokens, store);
		} catch (err) {
			console.warn(
				`[Gateway RateLimit] addTokens failed subject=${target.subject}, tpm window not updated:`,
				err instanceof Error ? err.message : String(err)
			);
		}
	}
}
