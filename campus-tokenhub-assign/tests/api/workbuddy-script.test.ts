import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listChatModels: vi.fn(),
  getCatalog: vi.fn(),
}));

vi.mock('@/lib/gateway/catalog', () => ({
  listChatModels: mocks.listChatModels,
  getCatalog: mocks.getCatalog,
  resetCatalogCache: vi.fn(),
  CATALOG_TTL_MS: 15000,
}));

import { GET } from '@/app/api/portal/workbuddy/script/route';

/** 管理端给 id + 名称 + 模态；能力字段（上下文长度）由公开目录补 */
const CHAT_MODELS = [
  { id: 'glm-5.3', name: 'GLM-5.3', inputModalities: ['text', 'image'], outputModalities: ['text'] },
  { id: 'deepseek/v4', name: 'DeepSeek V4', inputModalities: ['text'], outputModalities: ['text'] },
  // 有对话路由但输出不是文本的模型：不能接 WorkBuddy，脚本里要排除
  { id: 'kinfra-text-embedding-4b', name: 'Embedding 4B', inputModalities: ['text'], outputModalities: ['embedding'] },
  { id: 'kling-image-v3', name: 'Kling Image V3', inputModalities: ['text'], outputModalities: ['image'] },
];

const CATALOG_MODELS = [
  {
    id: 'glm-5.3',
    display_name: 'GLM-5.3',
    input_modalities: ['text', 'image'],
    context_window: 131072,
    max_tokens: 8192,
    inbound: [{ operation: 'chat' }],
  },
  {
    id: 'deepseek/v4',
    display_name: 'DeepSeek V4',
    input_modalities: ['text'],
    context_window: null,
    max_tokens: null,
    inbound: [{ operation: 'chat' }],
  },
];

/** 从脚本里捞出模型 JSON（mac 走 heredoc，windows 走 here-string） */
function payloadOf(script: string, platform: 'mac' | 'windows'): unknown {
  const startMarker = platform === 'mac' ? "<<'WORKBUDDY_MODELS_JSON'\n" : "$payloadRaw = @'\n";
  const endMarker = platform === 'mac' ? '\nWORKBUDDY_MODELS_JSON\n' : "\n'@\n";
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(script.slice(start + startMarker.length, end));
}

function makeRequest(query: string, apiKey?: string): Request {
  const headers: Record<string, string> = {};
  if (apiKey) headers['x-api-key'] = apiKey;
  return new Request(`http://portal.test/api/portal/workbuddy/script${query}`, { headers });
}

describe('GET /api/portal/workbuddy/script', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('NEXT_PUBLIC_PROXY_BASE', 'http://gateway.test:8790');
    mocks.listChatModels.mockResolvedValue(CHAT_MODELS);
    mocks.getCatalog.mockResolvedValue({ models: CATALOG_MODELS, stale: false, fetchedAt: Date.now() });
  });

  it('没有 X-Api-Key 时拒绝', async () => {
    const response = await GET(makeRequest('?platform=mac'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('X-Api-Key') });
  });

  it('未配置接口地址时拒绝生成半成品脚本', async () => {
    vi.stubEnv('NEXT_PUBLIC_PROXY_BASE', '');
    const response = await GET(makeRequest('?platform=mac', 'sk-test-123'));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining('NEXT_PUBLIC_PROXY_BASE'),
    });
  });

  it('按 Key 与选中模型返回可执行脚本', async () => {
    const response = await GET(makeRequest('?platform=mac&models=glm-5.3', 'sk-test-123'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store');

    const script = await response.text();
    expect(script.startsWith('#!/usr/bin/env bash')).toBe(true);
    expect(payloadOf(script, 'mac')).toEqual([
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        vendor: 'Custom',
        url: 'http://gateway.test:8790/v1/chat/completions',
        apiKey: 'sk-test-123',
        supportsToolCall: true,
        supportsImages: true,
        // 官方能力列里 glm-5.3 标注「深度思考」，写进配置时要打开思考模式
        supportsReasoning: true,
        useCustomProtocol: false,
        maxInputTokens: 131072,
        maxOutputTokens: 8192,
      },
    ]);
  });

  it('不传 models 时只写入可接入的文本模型，嵌入/生图类被排除', async () => {
    const script = await (await GET(makeRequest('?platform=mac', 'sk-test-123'))).text();
    const entries = payloadOf(script, 'mac') as { id: string; supportsReasoning: boolean }[];
    expect(entries.map((entry) => entry.id)).toEqual(['glm-5.3', 'deepseek/v4']);
    // 目录里没有的模型不瞎猜能力，保持 false
    expect(entries.map((entry) => entry.supportsReasoning)).toEqual([true, false]);
  });

  it('显式点名嵌入 / 生图模型时返回 400', async () => {
    for (const id of ['kinfra-text-embedding-4b', 'kling-image-v3']) {
      const response = await GET(makeRequest(`?platform=mac&models=${encodeURIComponent(id)}`, 'sk-test-123'));
      expect(response.status, id).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('文本模型') });
    }
  });

  it('windows 返回的文本不带 BOM，便于管道给 iex', async () => {
    const response = await GET(makeRequest('?platform=windows&models=deepseek%2Fv4', 'sk-test-123'));
    const script = await response.text();
    expect(script.startsWith('\uFEFF')).toBe(false);
    expect(script.startsWith('# 由')).toBe(true);
    expect((payloadOf(script, 'windows') as { id: string }[]).map((entry) => entry.id)).toEqual(['deepseek/v4']);
  });

  it('模型都不在目录里时返回 400', async () => {
    const response = await GET(makeRequest('?platform=mac&models=not-exist', 'sk-test-123'));
    expect(response.status).toBe(400);
  });

  it('Key 含引号/空白/命令分隔符时按 400 拒绝', async () => {
    // 这个 Key 会被原样拼进「复制执行」的 curl / powershell 命令，
    // 放行引号与分号等于开放命令注入，因此接口层必须用字符白名单先挡一次。
    const bad = [
      "sk-'; rm -rf ~; '",
      'sk-`id`-abcdefgh',
      'sk-$HOME-abcdefgh',
      'sk-a b c d e f g',
      'sk-a;b|c&d>e-fgh',
      'short',
    ];
    for (const key of bad) {
      const response = await GET(makeRequest('?platform=mac', key));
      expect(response.status, key).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringContaining('X-Api-Key') });
    }
  });

  it('目录不可用时返回 503', async () => {
    mocks.listChatModels.mockRejectedValue(new Error('gateway down'));
    mocks.getCatalog.mockRejectedValue(new Error('gateway down'));
    const response = await GET(makeRequest('?platform=mac', 'sk-test-123'));
    expect(response.status).toBe(503);
  });
});
