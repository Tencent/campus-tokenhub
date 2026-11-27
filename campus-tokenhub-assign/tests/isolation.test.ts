import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * 门禁脚本是纯 ESM（scripts/check-isolation.mjs），不带类型声明。
 * 用动态导入压掉类型检查，运行时行为由 vitest 的 esbuild 转译保证。
 */
// @ts-expect-error -- 纯 ESM 门禁脚本没有类型声明
const { scanDir } = await import('../scripts/check-isolation.mjs');

const created: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'iso-assign-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('assign 侧隔离门禁', () => {
  it('检出静态 import 的成员模块依赖，并报出文件与行号', () => {
    const root = fixture({
      'src/lib/example.ts': [
        "import { x } from './local';",
        "import { readStore } from '@/lib/members/store';",
      ].join('\n'),
    });

    const hits = scanDir(root);

    expect(hits).toHaveLength(1);
    expect(hits[0].file.endsWith('src/lib/example.ts')).toBe(true);
    expect(hits[0].line).toBe(2);
  });

  it('检出 import type 与动态 import()', () => {
    const root = fixture({
      'src/lib/a.ts': "import type { MemberStatus } from '@/lib/members/types';",
      'src/lib/b.ts': "const mod = await import('@/lib/tencent/organization');",
    });

    const hits = scanDir(root);

    expect(hits.map((hit: { file: string }) => hit.file.split('/').pop()).sort()).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('检出腾讯云凭据与成员配置环境变量', () => {
    const root = fixture({
      'src/lib/c.ts':
        "const id = process.env.TENCENTCLOUD_SECRET_ID;\nconst p = process.env.MEMBER_ACCOUNT_PROVIDER;",
    });

    const hits = scanDir(root);

    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it('干净目录返回空数组', () => {
    const root = fixture({
      'src/lib/ok.ts': "export const a = 1;\nimport { db } from '@/lib/db/portal-db';",
    });

    expect(scanDir(root)).toEqual([]);
  });

  it('不扫非源码文件（md/json 里的字样不误报）', () => {
    const root = fixture({
      'src/README.md': '这里提到 @/lib/members 只是文档说明\n',
      'src/data.json': '{"note":"lib/tencent"}\n',
    });

    expect(scanDir(root)).toEqual([]);
  });

  it('octafuse 相关字样在 assign 侧属正常，不报', () => {
    const root = fixture({
      'src/lib/ok2.ts': "const base = process.env.OCTAFUSE_ADMIN_BASE;\nconst id = session.octafuse_user_id;",
    });

    expect(scanDir(root)).toEqual([]);
  });
});
