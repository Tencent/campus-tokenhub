/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

const userFieldToFormField = {
  email: 'email',
  status: 'status',
  budget_max: 'budget_max',
  budget_base: 'budget_base',
  budget_spent: 'budget_spent',
  budget_period: 'budget_period',
  budget_reset_at: 'budget_reset_at',
  wallet_granted: 'wallet_granted',
  wallet_spent: 'wallet_spent',
  external_system: 'external_system',
  external_user_id: 'external_user_id',
  metadata_replace: 'metadata',
  charged_cost_factors: 'chargedCostFactorRows',
} as const;

/**
 * `rate_limit` 的 rpm / tpm 两维共用一个 payload 字段，任一维变化都要发，
 * 因此不放进 `userFieldToFormField` 的一对一映射，单独比较。
 */
const RATE_LIMIT_FORM_FIELDS = ['rateLimitRpm', 'rateLimitTpm'] as const;

function rateLimitFormChanged(
  current: Record<string, unknown>,
  saved: Record<string, unknown>
): boolean {
  return (
    JSON.stringify(RATE_LIMIT_FORM_FIELDS.map((field) => current[field])) !==
    JSON.stringify(RATE_LIMIT_FORM_FIELDS.map((field) => saved[field]))
  );
}

/** Do not send stale usage counters when saving unrelated account settings. */
export function pickChangedUserFields(
  payload: Record<string, unknown>,
  current: Record<string, unknown>,
  saved: Record<string, unknown>
): Record<string, unknown> {
  const patch: Record<string, unknown> = { reason: payload.reason };
  for (const [field, formField] of Object.entries(userFieldToFormField)) {
    if (
      Object.prototype.hasOwnProperty.call(payload, field) &&
      JSON.stringify(current[formField]) !== JSON.stringify(saved[formField])
    ) {
      patch[field] = payload[field];
    }
  }
  // rate_limit：两维任一变化就要发（含「清空成不限」这种显式 null）
  if (
    Object.prototype.hasOwnProperty.call(payload, 'rate_limit') &&
    rateLimitFormChanged(current, saved)
  ) {
    patch.rate_limit = payload.rate_limit;
  }
  // Changing a cycle or reset date must not implicitly reset accumulated usage.
  if ('budget_period' in patch || 'budget_reset_at' in patch) patch.reset_budget = false;
  return patch;
}

export type UserCreateDraft = {
  email: string;
  external_system: string;
  external_user_id: string;
  budget_max: string;
  budget_base: string;
  budget_period: string;
  metadata: string;
};

/** Validate the complete draft before any account is created. */
export function buildUserCreatePayload(form: UserCreateDraft): Record<string, unknown> {
  const email = form.email.trim();
  if (!email) throw new Error('emailRequired');
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('emailInvalid');
  const system = form.external_system.trim();
  const external = form.external_user_id.trim();
  if (Boolean(system) !== Boolean(external)) throw new Error('externalPair');
  const amount = (raw: string) => {
    if (!raw.trim()) return null;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error('amountInvalid');
    return value;
  };
  const body: Record<string, unknown> = {
    email,
    external_system: system || null,
    external_user_id: external || null,
    budget_period: form.budget_period,
    budget_max: amount(form.budget_max),
  };
  if (form.budget_base.trim()) body.budget_base = amount(form.budget_base);
  if (form.metadata.trim()) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(form.metadata);
    } catch {
      throw new Error('metadataObject');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error('metadataObject');
    body.metadata = metadata;
  }
  return body;
}
