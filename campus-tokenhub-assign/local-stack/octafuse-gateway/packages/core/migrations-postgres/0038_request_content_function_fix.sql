-- Modified by the campus-tokenhub project (Tencent), 2026-11-24.
-- This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.

-- 修复 0037 的两个分区函数：显式 UTC 边界 + DROP 逐分区容错。
-- 0037 已在新装环境生效；本迁移覆盖已部署环境的旧定义。
SET search_path TO octafuse_gateway;

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

