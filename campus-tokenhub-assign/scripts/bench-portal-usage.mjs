#!/usr/bin/env node
/**
 * 门户数据看板：3 万人规模的读路径压测与对账。
 *
 * 为什么只压读路径：真正的风险是「看板查询随汇总表规模变慢」，而汇总写入的正确性
 * （水位单事务、累加 upsert、空主键过滤）已由 packages/admin/lib/portal-usage/service.test.ts
 * 覆盖。这里补的是「表里有几百万行时，单用户 30 天查询还快不快」。
 *
 * 前提（本地）：
 *   docker compose up -d postgres migrate gateway-admin
 *   node scripts/bench-portal-usage.mjs [--users 3000] [--rounds 10] [--keep]
 *
 * 做的事：
 * 1. 找一个已存在的网关用户作为压测目标；
 * 2. 往 portal_usage_daily 写入 users × 30 天的模拟数据（model_id 带 bench- 前缀，便于清理）；
 * 3. 连续请求 summary N 次，输出 P50/P95 与响应体大小；
 * 4. 把接口返回的 requests 与 SQL 直接求和对比；
 * 5. 默认清理所有 bench- 数据（--keep 保留）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const ADMIN_BASE = process.env.BENCH_ADMIN_BASE ?? 'http://127.0.0.1:8789';
const PG_CONTAINER = process.env.BENCH_PG_CONTAINER ?? 'campus-tokenhub-postgres';
const PG_USER = process.env.POSTGRES_USER ?? 'octafuse';
const PG_DB = process.env.POSTGRES_DB ?? 'octafuse';

function argValue(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const raw = process.argv[index + 1];
  return raw && !raw.startsWith('--') ? raw : true;
}

const USERS = Number(argValue('users', 3000));
const ROUNDS = Number(argValue('rounds', 10));
const KEEP = argValue('keep', false) === true;
const DAYS = 30;

function psql(sql) {
  return execFileSync(
    'docker',
    ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-t', '-A', '-c', sql],
    { encoding: 'utf8' }
  ).trim();
}

/** 从项目 .env 读网关集成密钥（与门户 config 用同一个变量） */
function adminApiKey() {
  const fromEnv = process.env.OCTAFUSE_ADMIN_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const key = envText.match(/^OCTAFUSE_ADMIN_API_KEY=(.*)$/m)?.[1]?.trim() ?? '';
  if (!key) throw new Error('未在 .env 中找到 OCTAFUSE_ADMIN_API_KEY');
  return key;
}

function pickTargetUser() {
  const row = psql(`SELECT id FROM octafuse_gateway.users ORDER BY created_at ASC LIMIT 1;`);
  const userId = row.split('\n')[0]?.trim();
  if (!userId) throw new Error('users 表为空，请先用演示登录或真实 SSO 登录一次');
  return userId;
}

function seed(userId) {
  console.log(`[bench] 写入 ${USERS} 个用户 × ${DAYS} 天的汇总数据…`);
  psql(`
    INSERT INTO octafuse_gateway.portal_usage_daily (
      user_id, day, model_id, tz, requests, success_count, error_count,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      charged_cost, latency_sum, latency_count, data_until, updated_at
    )
    SELECT
      CASE WHEN g = 1 THEN '${userId}' ELSE 'bench-user-' || g END,
      (CURRENT_DATE - (d || ' days')::interval)::date,
      'bench-model',
      'Asia/Shanghai',
      7, 6, 1,
      700, 300, 10, 0,
      0.0007, 6300, 7,
      NOW(), NOW()
    FROM generate_series(1, ${USERS}) g
    CROSS JOIN generate_series(0, ${DAYS - 1}) d
    ON CONFLICT (user_id, day, model_id, tz) DO UPDATE SET requests = EXCLUDED.requests;
  `);
  const total = psql(`SELECT COUNT(*) FROM octafuse_gateway.portal_usage_daily WHERE model_id = 'bench-model';`);
  console.log(`[bench] 汇总表 bench 行数：${total}`);
}

async function measure(apiKey, userId) {
  const url = `${ADMIN_BASE}/api/admin/portal-usage/summary?user_id=${userId}&days=${DAYS}`;
  const samples = [];
  let payloadBytes = 0;
  let body = null;

  for (let index = 0; index < ROUNDS; index += 1) {
    const startedAt = process.hrtime.bigint();
    const response = await fetch(url, { headers: { authorization: `Bearer ${apiKey}` } });
    const text = await response.text();
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (!response.ok) throw new Error(`summary 请求失败：${response.status} ${text.slice(0, 200)}`);
    samples.push(elapsedMs);
    payloadBytes = Buffer.byteLength(text);
    body = JSON.parse(text);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const pick = (ratio) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1],
    payloadBytes,
    body,
  };
}

function reconcile(userId, apiRequests) {
  const expected = Number(
    psql(`
      SELECT COALESCE(SUM(requests), 0)
      FROM octafuse_gateway.portal_usage_daily
      WHERE user_id = '${userId}' AND model_id = 'bench-model' AND tz = 'Asia/Shanghai';
    `)
  );
  return { expected, match: expected === apiRequests };
}

function cleanup() {
  psql(`DELETE FROM octafuse_gateway.portal_usage_daily WHERE model_id = 'bench-model' OR user_id LIKE 'bench-user-%';`);
  psql(`DELETE FROM octafuse_gateway.portal_usage_watermark WHERE name = 'portal_usage';`);
  console.log('[bench] 已清理压测数据');
}

async function main() {
  const userId = pickTargetUser();
  const apiKey = adminApiKey();
  console.log(`[bench] 目标用户：${userId}`);

  seed(userId);
  const result = await measure(apiKey, userId);

  const apiRequests = Number(result.body?.data?.kpis?.requests ?? 0);
  const check = reconcile(userId, apiRequests);

  console.log('\n=== 结果 ===');
  console.log(`P50: ${result.p50.toFixed(1)} ms`);
  console.log(`P95: ${result.p95.toFixed(1)} ms`);
  console.log(`MAX: ${result.max.toFixed(1)} ms`);
  console.log(`响应体: ${(result.payloadBytes / 1024).toFixed(1)} KB`);
  console.log(`序列点数: ${result.body?.data?.series?.length ?? 0}`);
  console.log(`接口 requests: ${apiRequests}，表内求和: ${check.expected}，一致: ${check.match ? '是' : '否'}`);

  const pass = result.p95 < 50 && result.payloadBytes < 8192 && check.match;
  console.log(pass ? '\n✅ 达到基线（P95 < 50ms、响应 < 8KB、汇总与表内一致）' : '\n❌ 未达基线');

  if (!KEEP) cleanup();
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error('[bench] 失败：', error instanceof Error ? error.message : error);
  if (!KEEP) {
    try {
      cleanup();
    } catch {
      // 清理失败不掩盖原始错误
    }
  }
  process.exitCode = 1;
});
