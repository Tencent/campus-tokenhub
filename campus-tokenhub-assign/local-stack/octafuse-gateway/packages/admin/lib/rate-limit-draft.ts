/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 限流表单草稿 → `rate_limit` payload（Key 编辑与用户概览共用）。
 *
 * 两维都是字符串输入：空串 = 该维不限。两维都空 → `null`（整层不限）；
 * 只填一维 → 只带该键，避免把没填的维度写成 0（`0` 是「全部拒绝」，语义完全不同）。
 */
export type RateLimitDraft = {
  rateLimitRpm: string;
  rateLimitTpm?: string;
};

export type RateLimitPayload = { rpm?: number; tpm?: number };

function parseField(raw: string | undefined, key: 'rpm' | 'tpm'): number | null {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(key);
  return n;
}

export function parseRateLimitDraft(draft: RateLimitDraft): RateLimitPayload | null {
  const rpm = parseField(draft.rateLimitRpm, 'rpm');
  const tpm = parseField(draft.rateLimitTpm, 'tpm');
  if (rpm == null && tpm == null) return null;
  const out: RateLimitPayload = {};
  if (rpm != null) out.rpm = rpm;
  if (tpm != null) out.tpm = tpm;
  return out;
}
