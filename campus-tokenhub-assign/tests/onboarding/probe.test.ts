import { describe, expect, it } from 'vitest';
import { maskKey, probeUpstream } from '@/lib/onboarding/probe';
import type { OnboardingPreset } from '@/lib/onboarding/types';

const preset: OnboardingPreset = {
  version: 'test',
  generatedAt: '2026-11-09T00:00:00.000Z',
  provider: {
    id: 'tencent-tokenhub',
    name: 'Tencent TokenHub',
    kind: '__custom__',
    endpoints: { openai: { base: 'https://tokenhub.example.com/v1/' } },
  },
  systemConfig: {},
  models: [
    {
      id: 'hy4',
      displayName: 'Hy4',
      vendor: 'tencent',
      contextWindow: 1024,
      maxTokens: 512,
      inputModalities: ['text'],
      outputModalities: ['text'],
      pricingProfile: null,
      recommended: true,
      needsPostpaid: false,
      route: {
        providerModelName: 'hy4',
        status: 'active',
        priority: 0,
        upstreamProtocol: 'openai',
        upstreamOperation: 'chat',
        priceOverride: null,
      },
    },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('probeUpstream', () => {
  it('模型列表可用时直接返回模型 id，并复用去掉末尾斜杠的 Base URL', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return jsonResponse(200, { data: [{ id: 'hy4' }, { id: 'glm-5.3' }, { id: 'hy4' }] });
    }) as typeof fetch;

    const result = await probeUpstream('sk-test-123456', { preset, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['hy4', 'glm-5.3']);
    expect(urls[0]).toBe('https://tokenhub.example.com/v1/models');
    expect(result.keyHint).toBe('sk-…3456');
  });

  it('模型列表 404 时退化为一次最小对话，成功即视为 Key 可用', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/models')) return jsonResponse(404, { error: 'not found' });
      return jsonResponse(200, { choices: [] });
    }) as typeof fetch;

    const result = await probeUpstream('sk-test-123456', { preset, fetchImpl });

    expect(result.ok).toBe(true);
    expect(result.models).toBeNull();
    expect(calls.some((url) => url.endsWith('/chat/completions'))).toBe(true);
  });

  it('两者都失败时返回可读错误，不回显 Key', async () => {
    const fetchImpl = (async () => jsonResponse(401, { error: 'invalid key' })) as typeof fetch;

    const result = await probeUpstream('sk-secret-abcdef', { preset, fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('401');
    expect(JSON.stringify(result)).not.toContain('sk-secret-abcdef');
  });

  it('网络异常按超时/不可达给出提示', async () => {
    const fetchImpl = (async () => {
      const error = new Error('aborted');
      error.name = 'TimeoutError';
      throw error;
    }) as typeof fetch;

    const result = await probeUpstream('sk-test-123456', { preset, fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
  });
});

describe('maskKey', () => {
  it('短 Key 全掩码，长 Key 只留头尾', () => {
    expect(maskKey('abc')).toBe('***');
    expect(maskKey('sk-1234567890abcd')).toBe('sk-…abcd');
  });
});
