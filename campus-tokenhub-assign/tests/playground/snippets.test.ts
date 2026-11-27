import { describe, expect, it } from 'vitest';
import { buildPayload } from '@/lib/playground/payload';
import { KEY_PLACEHOLDER, renderCurl, renderNode, renderPython } from '@/lib/playground/snippets';
import type { CatalogModel } from '@/lib/gateway/types';

const chatModel: CatalogModel = {
  id: 'hy4',
  display_name: 'hy4',
  vendor: 'tencent',
  context_window: 128000,
  max_tokens: 4096,
  input_modalities: ['text'],
  output_modalities: ['text'],
  inbound: [{ protocol: 'openai', operation: 'chat' }],
  route_groups: ['default'],
  tags: [],
  pricing_profile: { tiers: [{ input_price: 1 }] },
  discounts: {},
};

const baseUrl = 'https://ai.school.edu.cn/';

function payloadFor(prompt: string) {
  return buildPayload({
    model: chatModel,
    operation: 'chat',
    form: { messages: [{ role: 'user', content: prompt }] },
  });
}

describe('renderCurl', () => {
  it('三要素齐全：地址拼接干净、Bearer 占位、Content-Type', () => {
    const built = payloadFor('你好');
    const curl = renderCurl({ baseUrl, path: built.path, body: built.body });

    expect(curl).toContain('https://ai.school.edu.cn/v1/chat/completions');
    expect(curl).toContain(`Bearer ${KEY_PLACEHOLDER}`);
    expect(curl).toContain('-H "Content-Type: application/json"');
    expect(curl).toContain('"model":"hy4"');
  });

  it('含中文与单引号时用 shell 转义，仍是可执行片段', () => {
    const built = payloadFor("帮我写一句 'hello' 的中文翻译");
    const curl = renderCurl({ baseUrl, path: built.path, body: built.body });

    expect(curl).toContain(`'\\''hello'\\''`);
    expect(curl).not.toContain(`'{"model":"hy4","messages":[{"role":"user","content":"帮我写一句 'hello'`);
  });

  it('带真实 Key 时替换占位符', () => {
    const built = payloadFor('hi');
    const curl = renderCurl({ baseUrl, path: built.path, body: built.body, apiKey: 'sk-real-key' });

    expect(curl).toContain('Bearer sk-real-key');
    expect(curl).not.toContain(KEY_PLACEHOLDER);
  });

  it('M6：真实 Key 里的 shell 元字符被转义，无法逃逸出双引号', () => {
    const built = payloadFor('hi');
    const curl = renderCurl({
      baseUrl,
      path: built.path,
      body: built.body,
      apiKey: 'sk-a"$(id)"$`whoami`',
    });

    expect(curl).toContain('\\"');
    expect(curl).toContain('\\$(id)');
    // 去掉已转义的 \$ 后，不应残留任何可执行的命令替换
    expect(curl.replace(/\\\$/g, '')).not.toContain('$(');
  });

  it('M6：占位符分支仍保持 $PORTAL_KEY 可被 shell 展开', () => {
    const built = payloadFor('hi');
    const curl = renderCurl({ baseUrl, path: built.path, body: built.body });

    expect(curl).toContain(`"Authorization: Bearer ${KEY_PLACEHOLDER}"`);
  });
});

describe('renderPython', () => {
  it('用 openai SDK，payload 与 buildPayload 输出一致', () => {
    const built = payloadFor('你好');
    const python = renderPython({ baseUrl, path: built.path, body: built.body });

    expect(python).toContain('from openai import OpenAI');
    expect(python).toContain('client.chat.completions.create(**payload)');
    expect(python).toContain('os.environ.get("PORTAL_KEY", "")');
    expect(python).toContain('"model": "hy4"');
    expect(python).toContain('"content": "你好"');
  });

  it('布尔与 null 转成 Python 字面量', () => {
    const built = buildPayload({
      model: chatModel,
      operation: 'chat',
      form: { messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    const python = renderPython({ baseUrl, path: built.path, body: built.body });

    expect(python).toContain('"stream": True');
    expect(python).toContain('"max_tokens": 1024');
    expect(python).not.toContain(': true');
  });

  it('带真实 Key 时写死字面量', () => {
    const built = payloadFor('hi');
    const python = renderPython({ baseUrl, path: built.path, body: built.body, apiKey: 'sk-real' });

    expect(python).toContain('api_key="sk-real"');
  });
});

describe('renderNode', () => {
  it('用 openai SDK，body 与 buildPayload 完全一致', () => {
    const built = payloadFor('你好');
    const node = renderNode({ baseUrl, path: built.path, body: built.body });

    expect(node).toContain("import OpenAI from 'openai'");
    expect(node).toContain('client.chat.completions.create(payload)');
    expect(node).toContain('process.env.PORTAL_KEY');
    expect(node).toContain(JSON.stringify(built.body, null, 2));
  });

  it('非 typed 端点回退到 client.post', () => {
    const built = buildPayload({
      model: chatModel,
      operation: 'responses',
      form: {},
    });
    const node = renderNode({ baseUrl, path: built.path, body: built.body });

    expect(node).toContain('client.post("/responses"');
  });
});
