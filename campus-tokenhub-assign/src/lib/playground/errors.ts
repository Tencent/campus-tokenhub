/**
 * 网关错误码 → 学生能看懂的中文。
 *
 * 权威分类是响应头 `X-OctaFuse-Error-Code`，HTTP 状态只是辅助
 * （404 可能是 `gateway.model_not_found`、`gateway.no_route`、`upstream.not_found`）。
 * 未知错误码回退到通用文案，但保留原始 message，便于学生报给管理员。
 */

export type ErrorInput = {
  status?: number;
  code?: string | null;
  message?: string | null;
  /** 熔断场景由响应头 / body 给出的冷却秒数 */
  retryAfterSeconds?: number | null;
};

export type ErrorExplanation = {
  title: string;
  hint: string;
  /** 需要倒计时禁用发送时才有值 */
  retryAfterSeconds?: number;
  /** 原始 message，展开「原始响应」时用 */
  rawMessage: string | null;
};

export function explainError(input: ErrorInput): ErrorExplanation {
  const code = (input.code ?? '').trim();
  const status = input.status ?? 0;
  const rawMessage = input.message?.trim() || null;

  if (code === 'circuit.upstream_capacity_exhausted') {
    const seconds = input.retryAfterSeconds ?? 300;
    return {
      title: `上游正在冷却，约 ${formatSeconds(seconds)} 后可重试`,
      hint: '这是供应商级别的共享状态：一个模型触发了 402/401 后，同供应商的所有模型都会一起被熔断，换模型也绕不开。',
      retryAfterSeconds: seconds,
      rawMessage,
    };
  }

  if (code === 'gateway.no_route') {
    return {
      title: '该模型当前没有可用路由',
      hint: '模型已下架或管理员正在调整路由，换一个模型试试；反复失败请联系管理员。',
      rawMessage,
    };
  }

  if (code === 'gateway.model_not_found') {
    return {
      title: '模型不存在或已下线',
      hint: '请刷新模型列表后重新选择，不要手写模型名。',
      rawMessage,
    };
  }

  if (code === 'gateway.auth_failed') {
    return {
      title: '密钥无效或已被吊销',
      hint: '到「密钥」页确认密钥状态；如果刚吊销过，请重新创建一把再试。',
      rawMessage,
    };
  }

  if (code === 'gateway.budget_exceeded' || code === 'gateway.insufficient_quota' || code === 'budget_exceeded') {
    return {
      title: '额度已用完',
      hint: '本期额度用完后将无法继续调用，需等额度重置或联系管理员调整。',
      rawMessage,
    };
  }

  if (code === '401007') {
    return {
      title: '该模型未在控制台开通后付费',
      hint: '这是平台侧未开通导致的，不是你的用法问题。请把模型名报给管理员，开通后立即可用。',
      rawMessage,
    };
  }

  if (code === 'circuit.sensitive_content') {
    return {
      title: '内容被安全策略拦截',
      hint: '换一种表述再试；如果认为误判，请联系管理员。',
      rawMessage,
    };
  }

  if (code.startsWith('upstream.')) {
    return {
      title: '上游模型服务返回错误',
      hint: '通常是上游临时故障或参数不被支持，稍后重试或精简参数（如换更小的 size）。',
      rawMessage,
    };
  }

  if (status === 401 || status === 403) {
    return {
      title: '没有权限调用该模型',
      hint: '确认密钥正确、额度未用尽；仍失败请联系管理员。',
      rawMessage,
    };
  }

  if (status === 402) {
    return {
      title: '上游服务未开通后付费',
      hint: '把模型名报给管理员在控制台开通，开通前该模型无法调用。',
      rawMessage,
    };
  }

  if (status === 429) {
    return {
      title: '请求太频繁或上游繁忙',
      hint: '稍等几秒再试；如果是熔断，需要等冷却结束。',
      rawMessage,
    };
  }

  if (status === 413) {
    return {
      title: '请求体过大',
      hint: '图片或附件太大，压缩后再试。',
      rawMessage,
    };
  }

  return {
    title: status > 0 ? `请求失败（HTTP ${status}）` : '请求失败',
    hint: rawMessage ?? '请检查参数后重试；持续失败请联系管理员。',
    rawMessage,
  };
}

function formatSeconds(seconds: number): string {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} 分钟`;
  return `${Math.max(1, Math.round(seconds))} 秒`;
}

/** 从响应头里取错误码与冷却秒数，缺头不抛错。 */
export function readGatewayError(headers: Headers): {
  code: string | null;
  retryAfterSeconds: number | null;
} {
  const code = headers.get('x-octafuse-error-code') ?? headers.get('X-OctaFuse-Error-Code');
  const retryRaw = headers.get('retry-after');
  const retry = retryRaw && Number.isFinite(Number(retryRaw)) ? Number(retryRaw) : null;
  return { code: code ?? null, retryAfterSeconds: retry };
}
