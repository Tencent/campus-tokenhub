/**
 * 网关响应的最小类型集。
 *
 * 字段名照抄实测响应（2026-11-05 本地 v2.18.0），只保留门户要用的部分：
 * 多了会误导后续开发，少了会让页面里到处 any。
 */

export type GatewayUser = {
  id: string;
  email: string;
  budget_max: number | null;
  budget_base: number | null;
  budget_spent: number | null;
  budget_period: string | null;
  budget_reset_at: string | null;
  wallet_granted: number | null;
  wallet_spent: number | null;
  /** 网关算好的永久额度余额；部分版本才返回，缺失时用 granted - spent 兜底 */
  wallet_balance?: number | null;
  /**
   * 用户级限流配置，未配置时为 null。
   * 结构由网关定义且本地实例全是 null，门户只按 `readRpmLimit` 防御式读 RPM。
   */
  rate_limit?: unknown;
  status: string;
  external_system: string | null;
  external_user_id: string | null;
  active_keys_count: number;
  created_at: string | null;
};

export type GatewayKey = {
  id: string;
  /**
   * 掩码串（服务端裁剪后的值，只保留前缀与末 4 位）。
   * 明文只在 `GET /api/portal/key` 与「创建成功」的响应里出现，不进页面 SSR 载荷。
   */
  key: string;
  name: string | null;
  status: string;
  last_used_at: string | null;
  created_at: string | null;
};

export type GatewayRequestLog = {
  id: string;
  /** 发起调用的网关用户；全局日志接口按 id 查询时返回，用户维度列表可能省略 */
  user_id?: string | null;
  model_id: string | null;
  /** 发起调用的密钥 ID，用来在明细里显示「使用的 Key」 */
  api_key_id?: string | null;
  route_group: string | null;
  /** 入口协议/操作（如 openai / chat），旧行可能为空 */
  request_protocol?: string | null;
  request_operation?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens: number | null;
  /** 字符串型金额，原样保留避免浮点误差 */
  charged_cost: string | null;
  status: string | null;
  latency_ms: number | null;
  /** 首 token / 流式总时长，看板明细用来判断是不是卡在排队 */
  first_token_ms?: number | null;
  stream_duration_ms?: number | null;
  error_message: string | null;
  created_at: string | null;
  /** 网关脱敏后的请求体（无消息正文），明细展开态展示 */
  request_body?: string | null;
};

export type CatalogInbound = {
  protocol?: string;
  operation?: string;
};

export type CatalogDiscountWindow = {
  catalog_factor?: number;
  route_factor?: number;
  composite_factor?: number;
};

export type CatalogDiscount = {
  timezone?: string;
  kind?: string;
  current?: CatalogDiscountWindow & { start?: string; end?: string; days?: number[] };
  provider_factor?: {
    base?: number;
    effective?: number;
    active?: boolean;
    starts_at?: string | null;
    expires_at?: string | null;
  } | null;
};

export type CatalogModel = {
  id: string;
  display_name: string | null;
  vendor: string | null;
  /** catalog 不返回；admin 视角可能带，用于排除 discontinued */
  status?: string;
  context_window: number | null;
  max_tokens: number | null;
  input_modalities: string[] | null;
  output_modalities: string[] | null;
  inbound: CatalogInbound[] | null;
  route_groups: string[] | null;
  tags: string[] | null;
  pricing_profile: {
    tiers?: {
      upto?: number | null;
      label?: string | null;
      input_price?: number | null;
      output_price?: number | null;
      cache_read_price?: number | null;
    }[];
    schedule?: { start: string; end: string; factor: number; days?: number[]; label?: string | null }[] | null;
    image_billing_mode?: string | null;
    image?: { default?: number | null } | null;
  } | null;
  discounts: Record<string, CatalogDiscount> | null;
};

export type GatewayListResponse<T> = {
  success: boolean;
  data: T[];
  total?: number;
  page?: number;
  page_size?: number;
};
