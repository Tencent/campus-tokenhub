#!/usr/bin/env node
/**
 * 管理员兜底命令：名单为空、首个登录者又不是 `school_id:user_id` 格式时，
 * 用它手工指定第一批管理员。
 *
 * 用法：npm run bootstrap-admin -- "school_001:100234567"
 *
 * 直接连库、直接写 `portal_shared.admins`，不依赖任何 Web 会话；
 * 幂等（ON CONFLICT DO NOTHING），可重复执行。
 */

import { Client } from 'pg';

const SHARED = 'portal_shared';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

async function main() {
  const sub = (process.argv[2] ?? '').trim();
  if (!/^[^:\s,]+:[^:\s,]+$/.test(sub)) {
    fail('身份格式应为 school_id:user_id，例如 school_001:100234567');
  }

  const connectionString = process.env.PORTAL_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    fail('未配置 PORTAL_DATABASE_URL，无法连接门户数据库');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${SHARED}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${SHARED}.admins (
        sub        text PRIMARY KEY,
        role       text NOT NULL DEFAULT 'portal_admin',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `INSERT INTO ${SHARED}.admins (sub) VALUES ($1) ON CONFLICT (sub) DO NOTHING`,
      [sub]
    );

    const { rows } = await client.query(
      `SELECT sub FROM ${SHARED}.admins ORDER BY created_at, sub`
    );
    console.log(`✅ 已确保 ${sub} 在管理员名单中；当前共 ${rows.length} 位：`);
    for (const row of rows) console.log(`   - ${row.sub}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('❌ 执行失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
