/**
 * 调用正文的读取与归属复核。
 *
 * 网关的正文接口 `GET /admin/request-logs/:id/content` 是管理面接口，没有用户维度，
 * 因此门户必须先自己确认这条日志属于当前用户，再把正文交出去。
 *
 * 归属判定用日志行自带的 `user_id`（网关全局日志接口按 id 查询时会返回），
 * 而不是 `api_key_id ∈ listKeys`：Key 被撤销后是物理删除，
 * 用 Key 做口径会让用户在**自己的**明细里点开历史调用却得到 404。
 */

import { getGatewayClient, type GatewayClient } from './client';
import type { GatewayListResponse, GatewayRequestLog } from './types';

/** 门户侧单侧正文上限：网关单侧可到 64KB，两侧一起下发会顶大响应 */
export const PORTAL_CONTENT_MAX_CHARS = 20_000;

export type RequestContentState = 'captured' | 'truncated' | 'missing';

export type RequestContent = {
	state: RequestContentState;
	inputText: string | null;
	outputText: string | null;
	/** 该侧被截断：网关侧标记或门户侧 2 万字符上限，取并集 */
	inputTruncated: boolean;
	outputTruncated: boolean;
};

/** 网关响应里实际用到的字段 */
type RawContent = {
	state?: string | null;
	inputText?: string | null;
	outputText?: string | null;
	inputTruncated?: boolean | null;
	outputTruncated?: boolean | null;
};

function normalizeState(raw: string | null | undefined): RequestContentState {
	if (raw === 'captured' || raw === 'truncated' || raw === 'missing') return raw;
	return 'missing';
}

/** 按 Unicode 码点裁剪，避免把代理对切成半个字符 */
function clipText(text: string | null | undefined): { text: string | null; truncated: boolean } {
	if (typeof text !== 'string') return { text: null, truncated: false };
	const points = Array.from(text);
	if (points.length <= PORTAL_CONTENT_MAX_CHARS) return { text, truncated: false };
	return { text: points.slice(0, PORTAL_CONTENT_MAX_CHARS).join(''), truncated: true };
}

/**
 * 按 id 取日志行，并确认网关确实返回了同一行。
 *
 * 不校验 `row.id === logId` 的话，一旦网关的 `id` 过滤失效（它会返回最新一行），
 * 就会拿别人的行通过归属检查，再用外部 `logId` 取到他人的正文。
 */
async function findLogById(
	logId: string,
	client: GatewayClient
): Promise<GatewayRequestLog | null> {
	const response = await client.admin<GatewayListResponse<GatewayRequestLog>>('/api/admin/request-logs', {
		query: { id: logId, page_size: 1 },
	});
	const row = response?.data?.[0];
	if (!row || row.id !== logId) return null;
	return row;
}

/**
 * 取一条调用的正文。
 *
 * - 返回 `null`：日志不存在，或不属于该用户（调用方统一 404，避免探测他人日志是否存在）
 * - 请求网关失败时抛出 `GatewayError`，由路由映射成 502，不会被伪装成 404
 */
export async function getOwnedRequestContent(
	logId: string,
	userId: string,
	client: GatewayClient = getGatewayClient()
): Promise<RequestContent | null> {
  const row = await findLogById(logId, client);
  if (!row) return null;
	// 严格等值：`user_id` 缺失（历史数据 / 匿名 Key / 字段改名）时按「不属于本人」处理。
	// 这里绝不能 fail-open——正文里是用户的 prompt 与响应，误放行等于跨用户泄露。
	if (!row.user_id || row.user_id !== userId) {
		if (!row.user_id) console.warn('[calls] 日志缺少 user_id，已拒绝返回正文', { logId });
		return null;
	}

	const raw = await client.admin<RawContent>(`/api/admin/request-logs/${encodeURIComponent(logId)}/content`);
	if (!raw) return null;

	const input = clipText(raw.inputText);
	const output = clipText(raw.outputText);
	const inputTruncated = Boolean(raw.inputTruncated) || input.truncated;
	const outputTruncated = Boolean(raw.outputTruncated) || output.truncated;
	const gatewayState = normalizeState(raw.state);

	return {
		// 任一侧被截断就归为 truncated，避免「截断了却宣称完整」
		state: gatewayState === 'captured' && (inputTruncated || outputTruncated) ? 'truncated' : gatewayState,
		inputText: input.text,
		outputText: output.text,
		inputTruncated,
		outputTruncated,
	};
}
