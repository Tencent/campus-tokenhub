#!/usr/bin/env node
/**
 * 校验两站的活动上报接口主体是否逐字相同。
 *
 * 为什么需要：`POST /api/portal/activity/visit` 在两站各有一份实现（都要各自的会话
 * 校验、同源校验与 recorder 实例，无法直接共享文件）。两份主体完全一致，只有文件头
 * 注释不同。谁改了其中一侧而忘了另一侧，不会报错，只会表现为「一个站的 PV 有数、
 * 另一个站的 PV 恒为 0」——这类问题只有上线后才被发现。
 *
 * 比对规则：忽略注释行与空行，只比代码主体。单仓库场景（CI 只 checkout 一个站）跳过。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REL = 'src/app/api/portal/activity/visit/route.ts';
const ROOT = process.cwd();
const PEERS = ['../campus-tokenhub-assign', '../campus-tokenhub-member'];

/** 去掉注释行与空行，只留代码主体 */
function normalize(file) {
  return readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*(\/?\*|\/\/|\/\*)/.test(line))
    .filter((line) => line.trim() !== '')
    .join('\n');
}

const selfPath = path.join(ROOT, REL);
if (!existsSync(selfPath)) {
  console.error(`❌ 找不到 ${REL}，请在门户站点根目录执行`);
  process.exit(1);
}

const peer = PEERS.map((dir) => path.join(ROOT, dir, REL)).find(
  (candidate) => path.resolve(candidate) !== path.resolve(selfPath) && existsSync(candidate)
);

if (!peer) {
  console.log('⏭  未找到兄弟站点，跳过两侧比对（单仓库场景正常）');
  process.exit(0);
}

const mine = normalize(selfPath).split('\n');
const theirs = normalize(peer).split('\n');

const max = Math.max(mine.length, theirs.length);
const diffs = [];
for (let i = 0; i < max; i += 1) {
  if (mine[i] !== theirs[i]) {
    diffs.push(`  第 ${i + 1} 行\n    本侧: ${mine[i] ?? '<缺失>'}\n    对侧: ${theirs[i] ?? '<缺失>'}`);
  }
}

if (diffs.length > 0) {
  console.error(`❌ 两站上报接口主体不一致（${REL}）`);
  console.error(diffs.slice(0, 10).join('\n'));
  if (diffs.length > 10) console.error(`  …还有 ${diffs.length - 10} 处差异`);
  console.error('   修复：把一侧的改动同步到另一侧（只允许文件头注释不同）');
  process.exit(1);
}

console.log(`✅ 两站上报接口主体一致：${REL}`);
