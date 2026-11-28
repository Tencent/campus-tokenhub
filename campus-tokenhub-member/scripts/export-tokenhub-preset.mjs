#!/usr/bin/env node
/**
 * 从运行中的 OctaFuse 网关导出「推荐模型清单」，落盘成门户初始化用的 preset。
 *
 *   OCTAFUSE_ADMIN_API_KEY=<网关后台集成密钥> node scripts/export-tokenhub-preset.mjs [--provider tencent-tokenhub] [--out <path>]
 *
 * 读取顺序：进程环境变量 → 仓库根 .env。
 *   OCTAFUSE_ADMIN_BASE / OCTAFUSE_ADMIN_API_KEY（网关后台「系统集成 → 集成密钥」签发）
 *
 * 认证：门户已改用集成密钥 Bearer 调 /api/admin/*；网关账密登录默认关闭，
 * 不再走 /api/auth/login 换 admin_session。成员站运行时不依赖网关，本脚本只在
 * 网关运维时手动执行，需自行提供集成密钥（建议用 assign 站同一把具名 Key）。
 *
 * 只导出 provider / models / routes 三类公开配置，**不含任何 API Key**：
 * 门户初始化时由学校自己录入。重新对齐后把新文件放回
 * `src/lib/onboarding/presets/` 并更新 `preset.ts` 里的当前版本即可。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, raw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}

loadEnvFile(resolve(ROOT, '.env'));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ADMIN_BASE = (process.env.OCTAFUSE_ADMIN_BASE ?? 'http://127.0.0.1:8789').replace(/\/+$/, '');
const PROVIDER_ID = arg('provider', 'tencent-tokenhub');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = resolve(ROOT, arg('out', `src/lib/onboarding/presets/tokenhub-${TODAY}.json`));

const apiKey = process.env.OCTAFUSE_ADMIN_API_KEY?.trim();
if (!apiKey) {
  console.error('缺少 OCTAFUSE_ADMIN_API_KEY（网关后台「系统集成 → 集成密钥」签发，可通过环境变量或仓库根 .env 提供）');
  process.exit(1);
}

async function get(path) {
  const response = await fetch(`${ADMIN_BASE}${path}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`GET ${path} 失败：HTTP ${response.status} ${payload?.message ?? ''}`.trim());
  }
  return payload;
}

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function limit(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const providers = (await get('/api/admin/providers')).data ?? [];
const provider = providers.find((item) => item.id === PROVIDER_ID);
if (!provider) throw new Error(`网关里找不到 provider：${PROVIDER_ID}`);

const models = (await get('/api/admin/models')).data ?? [];
const routes = (await get(`/api/admin/routes?provider_id=${encodeURIComponent(PROVIDER_ID)}`)).data ?? [];
const routeByModel = new Map(routes.map((route) => [route.model_id, route]));

const entries = models
  .filter((model) => routeByModel.has(model.id))
  .map((model) => {
    const route = routeByModel.get(model.id);
    const outputModalities = parseJson(model.output_modalities);
    const needsPostpaid = Array.isArray(outputModalities) && outputModalities.some((m) => m === 'image' || m === 'video');
    return {
      id: model.id,
      displayName: model.display_name ?? null,
      vendor: model.vendor ?? 'tencent',
      contextWindow: limit(model.context_window),
      maxTokens: limit(model.max_tokens),
      inputModalities: parseJson(model.input_modalities),
      outputModalities,
      pricingProfile: parseJson(model.pricing_profile),
      recommended: route.status === 'active',
      needsPostpaid,
      route: {
        providerModelName: route.provider_model_name ?? model.id,
        status: route.status === 'active' ? 'active' : 'disabled',
        priority: limit(route.priority) ?? 0,
        upstreamProtocol: route.upstream_protocol ?? 'openai',
        upstreamOperation: route.upstream_operation ?? 'chat',
        priceOverride: parseJson(route.price_override),
      },
    };
  })
  .sort((a, b) => a.id.localeCompare(b.id));

const preset = {
  version: arg('version', TODAY),
  generatedAt: new Date().toISOString(),
  provider: {
    id: provider.id,
    name: provider.name,
    kind: provider.kind ?? '__custom__',
    endpoints: parseJson(provider.endpoints) ?? {},
  },
  systemConfig: {
    BILLING_CURRENCY: 'CNY',
    BUSINESS_TIMEZONE: 'Asia/Shanghai',
  },
  models: entries,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(preset, null, 2)}\n`, 'utf8');

const active = entries.filter((item) => item.recommended).length;
console.log(`已导出 ${entries.length} 个模型（推荐 ${active} 个）→ ${OUT}`);
