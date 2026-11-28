import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_OBSOLETE_INDEX_STATEMENTS,
  ACTIVITY_RETENTION_DAYS,
  ACTIVITY_SCHEMA_STATEMENTS,
} from '../src/schema';

describe('活动表 DDL', () => {
  const all = ACTIVITY_SCHEMA_STATEMENTS.join('\n');

  it('包含登录事件与页面访问两张表', () => {
    expect(all).toContain('portal_shared.login_events');
    expect(all).toContain('portal_shared.page_views');
  });

  it('site 只允许两个站点', () => {
    expect(all).toContain("CHECK (site IN ('assign', 'member'))");
  });

  it('建齐五个索引', () => {
    for (const index of [
      'login_events_occurred_at_idx',
      'page_views_occurred_at_idx',
      'login_events_sub_occurred_at_idx',
      'login_events_site_occurred_at_idx',
      'page_views_site_occurred_at_idx',
    ]) {
      expect(all).toContain(index);
    }
  });

  it('不再创建 page_views 的 (sub, occurred_at) 索引', () => {
    // 没有任何按 sub 过滤 page_views 的查询，实测 idx_scan = 0，只增加写入放大
    expect(all).not.toContain('page_views_sub_occurred_at_idx');
  });

  it('废弃索引在启动时清理', () => {
    expect(ACTIVITY_OBSOLETE_INDEX_STATEMENTS).toHaveLength(1);
    expect(ACTIVITY_OBSOLETE_INDEX_STATEMENTS[0]).toMatch(/^DROP INDEX IF EXISTS\b/i);
    expect(ACTIVITY_OBSOLETE_INDEX_STATEMENTS[0]).toContain(
      'portal_shared.page_views_sub_occurred_at_idx'
    );
  });

  it('每条语句都以 CREATE 开头', () => {
    for (const statement of ACTIVITY_SCHEMA_STATEMENTS) {
      expect(statement.trim()).toMatch(/^CREATE\b/i);
    }
  });

  it('不记录 query 或 IP 字段', () => {
    expect(all).not.toContain('query');
    expect(all).not.toContain('ip ');
    expect(all).not.toContain('user_agent');
  });

  it('留存 180 天', () => {
    expect(ACTIVITY_RETENTION_DAYS).toBe(180);
  });
});
