-- Modified by the campus-tokenhub project (Tencent), 2026-11-24.
-- This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.

-- 门户数据看板：按用户 × 日 × 模型 的用量预聚合（独立模块，不改动既有表）。
--
-- 背景：明细表 api_key_request_logs 每次调用写一行，且含 request_body / upstream_request_body /
-- raw_usage / pricing_audit 等大字段。3 万人规模下按时间窗扫明细出趋势图会在单进程 admin 上超载
-- （本地实测：30 天 6 万行，30 个单日桶 fan-out 622ms，整段一次聚合 57~111ms）。
-- 因此把用量增量汇总到本表，看板只读小表，查询与明细行数解耦。
SET search_path TO octafuse_gateway;

CREATE TABLE IF NOT EXISTS portal_usage_daily (
  user_id TEXT NOT NULL,
  day DATE NOT NULL,
  model_id TEXT NOT NULL,
  -- 业务时区（IANA）。参与主键：时区变更后新旧数据不混桶，历史桶保留原口径
  tz TEXT NOT NULL,
  requests BIGINT NOT NULL DEFAULT 0,
  success_count BIGINT NOT NULL DEFAULT 0,
  error_count BIGINT NOT NULL DEFAULT 0,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_write_tokens BIGINT NOT NULL DEFAULT 0,
  charged_cost NUMERIC(18, 6) NOT NULL DEFAULT 0,
  -- latency_ms 可能为 NULL：存 sum/count 求均值，避免把空值当 0 稀释
  latency_sum BIGINT NOT NULL DEFAULT 0,
  latency_count BIGINT NOT NULL DEFAULT 0,
  -- 本行覆盖到的时间上界，前端展示「数据截至」
  data_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day, model_id, tz)
);

CREATE INDEX IF NOT EXISTS idx_portal_usage_daily_user_day ON portal_usage_daily(user_id, day);

-- 补算水位：与汇总写入同一事务推进，保证「重跑/重启不重复计数」
CREATE TABLE IF NOT EXISTS portal_usage_watermark (
  name TEXT PRIMARY KEY,
  last_ts TIMESTAMPTZ NOT NULL
);
