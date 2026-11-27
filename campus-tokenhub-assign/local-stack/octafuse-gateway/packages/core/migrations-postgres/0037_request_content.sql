-- Modified by the campus-tokenhub project (Tencent), 2026-11-24.
-- This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.

-- 网关提示词输入输出正文旁路表（按月 RANGE 分区）。
--
-- 背景：`api_key_request_logs` 已被门户用量看板的增量补算扫描，直接加宽列会降低堆页密度、
-- 拖慢统计链路。因此正文单独存放，主表零 schema 变更。
--
-- 约束：
-- - 复合主键 `(request_log_id, created_at)`：PG 分区表要求唯一约束包含分区键；
-- - `created_at` 与 `api_key_request_logs.created_at` 必须是同一时间戳（由应用侧显式写入），
--   否则毫秒差异会让同一请求落在相邻月份的分区，点查命中不到；
-- - 分区边界按 UTC 自然月。业务时区差异（最多 8 小时）只影响最早分区的删除时机，不影响点查。
SET search_path TO octafuse_gateway;

CREATE TABLE IF NOT EXISTS request_content (
  request_log_id    TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  user_id           TEXT,
  model_id          TEXT,
  request_protocol  TEXT,
  request_operation TEXT,
  status            TEXT,
  input_text        TEXT,
  output_text       TEXT,
  input_chars       INT,
  output_chars      INT,
  input_truncated   BOOLEAN     NOT NULL DEFAULT false,
  output_truncated  BOOLEAN     NOT NULL DEFAULT false,
  schema_version    SMALLINT    NOT NULL DEFAULT 1,
  PRIMARY KEY (request_log_id, created_at)
) PARTITION BY RANGE (created_at);

-- 幂等创建指定月份的分区。传入该月任意一天，内部按 UTC 月初对齐。
-- 显式 AT TIME ZONE 'UTC'：不依赖会话 TimeZone，避免迁移与运行时设置不一致时分区 overlap。
CREATE OR REPLACE FUNCTION octafuse_gateway.request_content_ensure_partition(target_month date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  month_start timestamptz;
  month_end   timestamptz;
  part_name   text;
BEGIN
  month_start := date_trunc('month', target_month::timestamp) AT TIME ZONE 'UTC';
  month_end   := (date_trunc('month', target_month::timestamp) + interval '1 month') AT TIME ZONE 'UTC';
  part_name   := 'request_content_' || to_char(month_start AT TIME ZONE 'UTC', 'YYYY_MM');

  IF to_regclass(format('octafuse_gateway.%I', part_name)) IS NOT NULL THEN
    RETURN part_name;
  END IF;

  EXECUTE format(
    'CREATE TABLE octafuse_gateway.%I PARTITION OF octafuse_gateway.request_content FOR VALUES FROM (%L) TO (%L)',
    part_name, month_start, month_end
  );
  RETURN part_name;
END;
$$;

-- 删除早于保留期的分区（整月删除）。
-- lock_timeout 防止高峰 DROP 长时间阻塞正文查询；单个分区超时只跳过该分区，
-- 不影响其他过期分区被删除（每个 DROP 独立 EXCEPTION 块）。
CREATE OR REPLACE FUNCTION octafuse_gateway.request_content_drop_expired(retention_days int DEFAULT 90)
RETURNS text[]
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff    timestamptz;
  rec       record;
  part_from timestamptz;
  dropped   text[] := ARRAY[]::text[];
BEGIN
  PERFORM set_config('lock_timeout', '3s', true);
  cutoff := date_trunc('month', (now() - make_interval(days => retention_days))::timestamp) AT TIME ZONE 'UTC';

  FOR rec IN
    SELECT child.relname AS relname
    FROM pg_inherits
    JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
    JOIN pg_class child ON child.oid = pg_inherits.inhrelid
    JOIN pg_namespace ns ON ns.oid = parent.relnamespace
    WHERE ns.nspname = 'octafuse_gateway'
      AND parent.relname = 'request_content'
      AND child.relname ~ '^request_content_[0-9]{4}_[0-9]{2}$'
  LOOP
    part_from := (to_date(substring(rec.relname from '[0-9]{4}_[0-9]{2}$'), 'YYYY_MM')::timestamp) AT TIME ZONE 'UTC';
    IF part_from + interval '1 month' <= cutoff THEN
      BEGIN
        EXECUTE format('DROP TABLE octafuse_gateway.%I', rec.relname);
        dropped := array_append(dropped, rec.relname);
      EXCEPTION
        WHEN lock_not_available OR undefined_table THEN
          -- 被长事务/备份占住：本轮跳过，下一轮重试；不中断其它分区的清理
          RAISE WARNING 'request_content: skip dropping partition %', rec.relname;
      END;
    END IF;
  END LOOP;

  RETURN dropped;
END;
$$;

-- 预建「当前月 + 未来 3 个月」，给发布与任务延后留出跑道。
SELECT octafuse_gateway.request_content_ensure_partition(
  (date_trunc('month', now()) + make_interval(months => i))::date
)
FROM generate_series(0, 3) AS t(i);
