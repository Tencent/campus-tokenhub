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
  const root = mkdtempSync(join(tmpdir(), 'iso-member-'));
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

describe('member 侧隔离门禁', () => {
  it('检出静态 import 的网关依赖，并报出文件与行号', () => {
    const root = fixture({
      'src/lib/example.ts': [
        "import { x } from './local';",
        "import { getGatewayClient } from '@/lib/gateway/client';",
      ].join('\n'),
    });

    const hits = scanDir(root);

    expect(hits).toHaveLength(1);
    expect(hits[0].file.endsWith('src/lib/example.ts')).toBe(true);
    expect(hits[0].line).toBe(2);
  });

  it('检出 import type 与动态 import()', () => {
    const root = fixture({
      'src/lib/a.ts': "import type { AdminProviderRow } from '@/lib/onboarding/gateway-state';",
      'src/lib/b.ts': "const mod = await import('@/lib/playground/stream');",
    });

    const hits = scanDir(root);

    expect(hits.map((hit: { file: string }) => hit.file.split('/').pop()).sort()).toEqual([
      'a.ts',
      'b.ts',
    ]);
  });

  it('检出环境变量与代理地址泄漏', () => {
    const root = fixture({
      'src/lib/c.ts': "const base = process.env.OCTAFUSE_ADMIN_BASE;\nconst p = getPublicProxyBase();",
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
      'src/README.md': '这里提到 @/lib/gateway 只是文档说明\n',
      'src/data.json': '{"note":"@/lib/onboarding"}\n',
    });

    expect(scanDir(root)).toEqual([]);
  });

  it('保留 octafuse_user_id 这个 claim 名不算违规（两边会话互认需要读它）', () => {
    const root = fixture({
      'src/lib/auth/session.ts':
        "const octafuse_user_id = typeof payload.octafuse_user_id === 'string' ? payload.octafuse_user_id : null;",
    });

    expect(scanDir(root)).toEqual([]);
  });
});
