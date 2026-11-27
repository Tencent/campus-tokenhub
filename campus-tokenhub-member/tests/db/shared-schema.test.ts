import { describe, expect, it } from 'vitest';
import { SHARED_SCHEMA_STATEMENTS } from '@/lib/db/shared-schema';
import { PORTAL_SCHEMA_STATEMENTS } from '@/lib/db/portal-schema';

/**
 * 共享层 DDL 的边界：`portal_shared` 由两个仓库共写同一份 schema，
 * 因此这份语句列表只能含共享表，绝不能混进本侧专属表。
 * （两侧文件是否逐字相同由 `npm run check:shared-ddl` 在本地比对）
 */
describe('共享层 DDL', () => {
  const all = SHARED_SCHEMA_STATEMENTS.join('\n');

  it('覆盖共享层的六张表', () => {
    for (const table of [
      'admins',
      'settings',
      'session_revocations',
      'config_audit',
    ]) {
      expect(all).toContain(`portal_shared.${table}`);
    }
    // 两张单行配置表走常量，断言到列级别更稳
    expect(all).toContain('singleton');
    expect(all).toContain('school_name');
  });

  it('不含任何本侧专属表（activity_configs / member_applications）', () => {
    expect(all).not.toContain('activity_configs');
    expect(all).not.toContain('member_applications');
  });

  it('不含本侧 schema 的创建语句', () => {
    expect(all).not.toContain('portal_assign');
    expect(all).not.toContain('portal_member');
  });

  it('PORTAL_SCHEMA_STATEMENTS 以共享层开头，再接本侧语句（保证 portal_shared 先于引用它的语句建好）', () => {
    const first = PORTAL_SCHEMA_STATEMENTS.slice(0, SHARED_SCHEMA_STATEMENTS.length);
    expect(first).toEqual([...SHARED_SCHEMA_STATEMENTS]);
    expect(PORTAL_SCHEMA_STATEMENTS.length).toBeGreaterThan(SHARED_SCHEMA_STATEMENTS.length);
  });

  it('每条语句都以 CREATE / ALTER / UPDATE / DELETE 开头（防止拼进半截字符串）', () => {
    for (const sql of SHARED_SCHEMA_STATEMENTS) {
      expect(sql.trim()).toMatch(/^(CREATE|ALTER|UPDATE|DELETE)\b/i);
    }
  });
});
