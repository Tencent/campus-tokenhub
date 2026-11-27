'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-26.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import { useState, useEffect } from 'react';
import {
  BILLING_CURRENCY_KEY,
  DEFAULT_BILLING_CURRENCY,
  normalizeBillingCurrencyCode,
} from '@octafuse/core/lib/billing-currency';
import { readApiJson } from '@/lib/api-json';
import type { SystemConfigRow } from '@/lib/types';
import { adminApiPath } from '@/lib/admin-browser-path';

/**
 * 从 `/api/admin/config` 读取 `BILLING_CURRENCY`；失败或未配置时回退网关默认币种（CNY）。
 */
export function useBillingCurrency(): { currency: string; loading: boolean } {
	const [currency, setCurrency] = useState(DEFAULT_BILLING_CURRENCY);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(adminApiPath('/api/admin/config'));
				const data = await readApiJson<SystemConfigRow[]>(res);
				if (cancelled) return;
				if (data.success && Array.isArray(data.data)) {
					const row = data.data.find((r) => r.key === BILLING_CURRENCY_KEY);
					setCurrency(normalizeBillingCurrencyCode(row?.value));
				} else {
					setCurrency(DEFAULT_BILLING_CURRENCY);
				}
			} catch {
				if (!cancelled) setCurrency(DEFAULT_BILLING_CURRENCY);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	return { currency, loading };
}
