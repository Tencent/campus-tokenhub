#!/usr/bin/env node
/**
 * 把共享活动包从符号链接换成真实副本。
 *
 * 背景：`@campus/portal-activity` 是 `file:../packages/portal-activity` 依赖，npm 装出来
 * 是 node_modules 里的符号链接，指向仓库根的 packages/portal-activity。Turbopack 只解析
 * root 范围内的模块，符号链接指向 root 之外时直接报
 * `Module not found: Can't resolve '@campus/portal-activity'`，生产构建与 dev 都起不来。
 *
 * 因此 postinstall / predev / prebuild 都先跑一遍本脚本：把 package.json 与 src 复制进
 * node_modules/@campus/portal-activity，成为 root 内的真实目录。镜像里目录结构与仓库一致
 * （/workspace/app + /workspace/packages），本地与容器行为一致。
 *
 * 幂等：已经是真实目录时直接覆盖重写；node_modules 还没装就跳过，不抛错。
 */

import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ENTRIES = ['package.json', 'src'];
const PACKAGE_NAME = '@campus/portal-activity';

const projectRoot = process.cwd();
const source = path.resolve(projectRoot, '../packages/portal-activity');
const target = path.resolve(projectRoot, 'node_modules', PACKAGE_NAME);

function skip(reason) {
  // 构建期静默跳过：npm install 前的脚本执行、或在没有共享包的环境里跑单包命令
  console.log(`[sync-activity] 跳过：${reason}`);
  process.exit(0);
}

if (!existsSync(source)) skip(`找不到共享包目录 ${source}`);
if (!existsSync(path.dirname(target))) skip('node_modules 尚未安装（先 npm ci）');

const missing = ENTRIES.filter((entry) => !existsSync(path.join(source, entry)));
if (missing.length > 0) skip(`共享包缺少 ${missing.join(', ')}`);

// 符号链接必须用 unlink 单独处理：rmSync 会顺着链接去掉目标目录里的内容
let existing = null;
try {
  existing = lstatSync(target);
} catch {
  existing = null;
}

if (existing?.isSymbolicLink()) {
  unlinkSync(target);
} else if (existing) {
  rmSync(target, { recursive: true, force: true });
}

mkdirSync(target, { recursive: true });
for (const entry of ENTRIES) {
  cpSync(path.join(source, entry), path.join(target, entry), { recursive: true });
}

console.log(`[sync-activity] 已同步 ${ENTRIES.join(' + ')} → node_modules/${PACKAGE_NAME}`);
