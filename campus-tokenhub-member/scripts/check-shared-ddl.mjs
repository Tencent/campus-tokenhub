#!/usr/bin/env node
/**
 * 校验两侧的共享层 DDL 是否逐字相同。
 *
 * 为什么需要：两站共用一个 `portal_shared` schema，但 DDL 各自有一份拷贝。
 * 谁先启动谁的表结构生效——如果两侧写法不同，会出现「一侧能写、另一侧读不到」的现象，
 * 且不会在启动时报错，只在运行时表现为字段为空或写入失败。
 *
 * 两道防线：
 *   1. 本脚本：本地开发时比对两个仓库的文件内容（CI 里通常只 checkout 一个仓库，会跳过）；
 *   2. `tests/db/shared-schema.test.ts`：单仓库内断言共享 DDL 只含共享表、不含本侧表。
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REL = 'src/lib/db/shared-schema.ts';
const ROOT = process.cwd();
const PEERS = ['../campus-tokenhub-assign', '../campus-tokenhub-member'];

const selfPath = path.join(ROOT, REL);
if (!existsSync(selfPath)) {
  console.error(`❌ 找不到 ${REL}，请在仓库根目录执行`);
  process.exit(1);
}

const peer = PEERS.map((dir) => path.join(ROOT, dir, REL)).find(
  (candidate) => path.resolve(candidate) !== path.resolve(selfPath) && existsSync(candidate)
);

if (!peer) {
  // 单仓库场景（CI、只 clone 一个仓库）：跳过而不是失败
  console.log('⏭  未找到兄弟仓库，跳过两侧比对（单仓库场景正常）');
  process.exit(0);
}

const normalize = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const mine = normalize(selfPath);
const theirs = normalize(peer);

if (mine === theirs) {
  console.log(`✅ 共享层 DDL 两侧一致：${REL}`);
  process.exit(0);
}

// 逐行指出差异位置，避免只丢一句「不一致」让人无从下手
const a = mine.split('\n');
const b = theirs.split('\n');
const firstDiff = a.findIndex((line, index) => line !== b[index]);
console.error('❌ 共享层 DDL 两侧不一致（portal_shared 由两侧共用，改一处必须同步另一处）');
console.error(`   本仓库：${selfPath}`);
console.error(`   兄弟仓库：${peer}`);
console.error(`   第一处差异在第 ${firstDiff + 1} 行：`);
console.error(`   - 本仓库： ${JSON.stringify(a[firstDiff] ?? '<文件结束>')}`);
console.error(`   + 兄弟仓库：${JSON.stringify(b[firstDiff] ?? '<文件结束>')}`);
process.exit(1);
