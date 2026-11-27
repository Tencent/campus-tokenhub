#!/usr/bin/env node
/**
 * 跨侧依赖门禁：扫 src/ 下的 TS/TSX，命中对方领域的标识符即失败。
 *
 * 用法：
 *   node scripts/check-isolation.mjs          # 严格模式，有命中退出码 1
 *   node scripts/check-isolation.mjs --warn   # 只报告，退出码 0（裁剪期过渡用）
 *
 * 为什么自写脚本而不用 eslint 规则：两个仓库各自独立，脚本零依赖、可直接在
 * CI 或 `npm test` 前置跑，错误信息能带中文说明；eslint 规则需要额外插件，
 * 且容易被 `eslint-disable` 绕过。
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RULES, SOURCE_EXT } from './isolation-rules.mjs';

const SKIP_DIRS = new Set(['node_modules', '.next', '.git', 'dist', 'coverage']);

/**
 * 递归扫描目录，返回命中列表。
 * @param {string} root 要扫描的根目录
 * @param {Array<{name: string, test: RegExp}>} [rules]
 * @returns {Array<{file: string, line: number, text: string, rule: string}>}
 */
export function scanDir(root, rules = RULES) {
  const hits = [];
  walk(root, rules, hits);
  return hits;
}

function walk(dir, rules, hits) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, rules, hits);
      continue;
    }

    if (!SOURCE_EXT.some((ext) => entry.name.endsWith(ext))) continue;

    const lines = readFileSync(full, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const rule of rules) {
        if (rule.test.test(lines[i])) {
          hits.push({ file: full, line: i + 1, text: lines[i].trim(), rule: rule.name });
        }
      }
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const warn = argv.includes('--warn');
  const cwd = process.cwd();
  const hits = scanDir(join(cwd, 'src'));

  if (hits.length === 0) {
    console.log('✅ 隔离检查通过：src/ 中无跨侧引用');
    return 0;
  }

  console.log(`发现 ${hits.length} 处跨侧引用：`);
  for (const hit of hits) {
    const where = `${relative(cwd, hit.file)}:${hit.line}`;
    console.log(`  ${where}  [${hit.rule}]  ${hit.text.slice(0, 120)}`);
  }

  if (warn) {
    console.log('（--warn 模式：仅报告，不阻断）');
    return 0;
  }
  return 1;
}

const invoked = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  process.exit(main());
}
