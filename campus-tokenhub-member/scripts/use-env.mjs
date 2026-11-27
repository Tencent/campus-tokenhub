#!/usr/bin/env node
/**
 * 环境切换：把 env/profiles/<name>.env 写进 .env.local。
 *
 * 为什么写 .env.local：Next 会按 `.env` < `.env.local` 的优先级加载，
 * 因此 `.env` 继续作为基线（密钥、学校编码、网关口令等不随环境变化的项），
 * 这里只覆盖「随环境变化」的几个地址与 Cookie 开关。
 * docker compose 不读 `.env.local`，所以另外生成 `docker-compose.override.yml`
 * （compose 默认自动加载、gitignore）覆盖 portal 容器的浏览器侧地址；
 * 部署机上没有这两个文件，走 `.env` 的线上值，行为不受影响。
 *
 *   node scripts/use-env.mjs local     # 切本地
 *   node scripts/use-env.mjs online    # 切线上
 *   node scripts/use-env.mjs lan       # 切局域网（自动填本机内网 IP）
 *   node scripts/use-env.mjs current   # 看当前生效的是哪套
 */
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const PROFILE_DIR = path.join(ROOT, 'env', 'profiles');
const TARGET = path.join(ROOT, '.env.local');
/** compose 的本地覆盖文件：默认自动加载，部署机上不存在；gitignore */
const COMPOSE_OVERRIDE = path.join(ROOT, 'docker-compose.override.yml');

/**
 * 需要同步写进 compose 覆盖文件的项。
 *
 * 这些值在 docker-compose.yml 里以 `environment:` 出现（优先级高于 `env_file`），
 * 只写 `.env.local` 只能影响 next dev，容器里仍然是 `.env` 的线上值。
 */
const COMPOSE_OVERRIDE_KEYS = [
  'PUBLIC_BASE_URL',
  'NEXT_PUBLIC_PROXY_BASE',
  'ADMIN_PUBLIC_BASE_URL',
  'COOKIE_SECURE',
  // 侧边栏校名：不写进容器的话只会显示「学校」兜底（.env.local 只影响 next dev）
  'PORTAL_SCHOOL_NAME',
];

/**
 * 需要写进 `gateway-admin` 容器覆盖的项。
 *
 * 管理台 SSO 会把这些地址下发给浏览器（未登录时跳转、退出时回清 Cookie）；
 * 不覆盖就会用 `.env` 里的线上地址，本机点「用学校账号登录」会被带到线上门户。
 */
const GATEWAY_ADMIN_OVERRIDE_KEYS = ['PORTAL_LOGIN_URL', 'PORTAL_LOGOUT_URL'];

const PROFILES = ['local', 'online', 'lan'];

/** profile 里代表「本机内网 IPv4」的占位符，切换时替换成实际地址 */
const LAN_IP_TOKEN = '__LAN_IP__';

/**
 * 取本机内网 IPv4。
 *
 * 跳过回环、169.254 链路本地与 IPv6；多网卡时优先 en0（Wi-Fi/有线主网卡），
 * 因为 mac 上 docker/utun 之类的虚拟网卡往往排在前面。
 */
function detectLanIp() {
  const candidates = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      const isV4 = info.family === 'IPv4' || info.family === 4;
      if (!isV4 || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: info.address });
    }
  }
  const preferred = candidates.find((item) => item.name === 'en0');
  return (preferred ?? candidates[0])?.address ?? '';
}

/** 替换 profile 文本里的占位符；含占位符但取不到 IP 时直接报错 */
function fillPlaceholders(text, profileName) {
  if (!text.includes(LAN_IP_TOKEN)) return text;
  const ip = detectLanIp();
  if (!ip) {
    console.error(`环境 ${profileName} 需要本机内网 IP，但没探测到任何非回环 IPv4 地址。`);
    console.error('请确认已连上局域网（Wi-Fi/网线），或手动改 .env.local。');
    process.exit(1);
  }
  return text.split(LAN_IP_TOKEN).join(ip);
}

/** 解析 KEY=VALUE，忽略注释与空行 */
function parseEnv(text) {
  const entries = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    entries.push([line.slice(0, index).trim(), line.slice(index + 1).trim()]);
  }
  return entries;
}

function renderProfile(name, entries, body) {
  return [
    `# 由 \`npm run env:${name}\` 生成，请勿手工编辑（改 env/profiles/${name}.env）`,
    `# 生效范围：本机 next dev / next start；docker compose 见 docker-compose.override.yml`,
    '',
    ...body.split('\n').filter((line) => !line.startsWith('#')),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

/**
 * compose 覆盖文件：只覆盖 portal 容器的浏览器侧地址，其余键沿用主文件。
 * 值统一加单引号：`COOKIE_SECURE=false` 不加引号会被 YAML 解析成布尔。
 *
 * ⚠️ 成员站没有 `gateway-admin` 服务：若仍往覆盖文件里写这个服务名，
 * `docker compose` 会报 "service gateway-admin has neither an image nor a build context"。
 * 这里读一次主 compose 判断服务是否存在，不存在就不写该段——两侧共用同一份脚本逻辑。
 */
function renderComposeOverride(name, entries) {
  const picked = entries.filter(([key]) => COMPOSE_OVERRIDE_KEYS.includes(key));
  const adminPicked = entries.filter(([key]) => GATEWAY_ADMIN_OVERRIDE_KEYS.includes(key));
  const hasAdminService = /^  gateway-admin:/m.test(
    readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')
  );
  const adminBlock =
    adminPicked.length > 0 && hasAdminService
      ? ['  gateway-admin:', '    environment:', ...adminPicked.map(([key, value]) => `      ${key}: '${value}'`)]
      : [];
  return [
    `# 由 \`npm run env:${name}\` 生成，请勿手工编辑（改 env/profiles/${name}.env）`,
    '# 作用：本机 `docker compose` 起 portal 容器时，浏览器侧地址用这套值，',
    '# 避免接入指南、跳转地址显示线上的域名。compose 默认自动加载本文件。',
    '# 部署机上没有这个文件，compose 走 .env 的线上值，行为不受影响。',
    'services:',
    '  portal:',
    '    environment:',
    ...picked.map(([key, value]) => `      ${key}: '${value}'`),
    ...adminBlock,
    '',
  ].join('\n');
}

async function readProfile(name) {
  const file = path.join(PROFILE_DIR, `${name}.env`);
  if (!existsSync(file)) {
    console.error(`找不到环境配置：${path.relative(ROOT, file)}`);
    console.error(`可用环境：${PROFILES.join(' / ')}`);
    process.exit(1);
  }
  const raw = await readFile(file, 'utf8');
  return { file, text: fillPlaceholders(raw, name) };
}

function describe(entries) {
  const width = Math.max(...entries.map(([key]) => key.length));
  for (const [key, value] of entries) {
    console.log(`  ${key.padEnd(width)}  ${value}`);
  }
}

/** 报告 compose 覆盖文件是否存在：决定本机 `docker compose` 用本地值还是 `.env` 的线上值 */
async function reportComposeOverride(profileName) {
  if (!existsSync(COMPOSE_OVERRIDE)) {
    console.log('docker-compose.override.yml：不存在，本机 docker compose 用 .env 的线上值');
    return;
  }
  console.log(
    `docker-compose.override.yml：存在，本机 docker compose（portal）用 ${
      profileName ? `env/profiles/${profileName}.env` : '自定义'
    } 的值`
  );
}

async function current() {
  if (!existsSync(TARGET)) {
    console.log('当前没有 .env.local，全部取 .env 的值（既不是 local 也不是 online 覆盖）。');
    await reportComposeOverride(null);
    return;
  }
  const entries = parseEnv(await readFile(TARGET, 'utf8'));
  const map = new Map(entries);
  for (const name of PROFILES) {
    const { text } = await readProfile(name);
    const profile = parseEnv(text);
    const same = profile.every(([key, value]) => map.get(key) === value);
    if (same) {
      console.log(`当前生效：${name}（.env.local 与 env/profiles/${name}.env 一致）`);
      describe([...map]);
      await reportComposeOverride(name);
      return;
    }
  }
  console.log('当前生效：自定义（.env.local 与现有 profile 都不一致）');
  describe([...map]);
  await reportComposeOverride(null);
}

async function main() {
  const name = (process.argv[2] ?? '').trim();

  if (!name || name === 'current') {
    await current();
    return;
  }

  if (!PROFILES.includes(name)) {
    console.error(`未知环境：${name}`);
    console.error(`可用环境：${PROFILES.join(' / ')}`);
    process.exit(1);
  }

  const { file, text } = await readProfile(name);
  const entries = parseEnv(text);
  await writeFile(TARGET, renderProfile(name, entries, text), 'utf8');
  await writeFile(COMPOSE_OVERRIDE, renderComposeOverride(name, entries), 'utf8');

  console.log(
    `已切换到 ${name} 环境（写入 .env.local 与 docker-compose.override.yml，来源 ${path.relative(ROOT, file)}）：`
  );
  describe(entries);
  const baseUrl = entries.find(([key]) => key === 'PUBLIC_BASE_URL')?.[1] ?? '';
  if (baseUrl) console.log(`\n门户地址：${baseUrl}/login`);
  console.log(`重启 dev server 后生效：${name === 'lan' ? 'npm run dev:lan' : 'npm run dev -- --port 3000'}`);
  console.log('本机 compose 生效：docker compose up -d --no-deps portal');
  if (name === 'lan') {
    // 回调地址是门户固定路径，只随部署域名变化
    const callback = baseUrl ? `${baseUrl}/api/auth/callback` : '/api/auth/callback';
    console.log(`
局域网提示：
  1. 其它设备用同一条网络访问上面这个地址（本机已监听 0.0.0.0，防火墙需放行 node）；
  2. IdP / CAS Server 的授权回调白名单必须包含：
     ${callback}
     否则授权页会拒绝 redirect_uri，登录走不通 —— 这项要在 IdP 侧配置。`);
  }
}

await main();
