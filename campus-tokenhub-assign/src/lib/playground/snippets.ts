/**
 * cURL / Python / Node 片段生成。
 *
 * 三个语言都吃同一份 `{path, body}`，所以预览永远和真实请求一致。
 * Key 由调用方传入真实值（调试台读到当前 Key 后直接写入）；传空则退回占位符。
 */

export const KEY_PLACEHOLDER = '$PORTAL_KEY';

export type SnippetInput = {
  /** 学生访问的地址，如 https://ai.school.edu.cn */
  baseUrl: string;
  /** /v1/chat/completions */
  path: string;
  body: Record<string, unknown>;
  /** 不传则用占位符 */
  apiKey?: string | null;
};

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

function sdkCall(path: string): { py: string; node: string; raw: string } {
  if (path.endsWith('/chat/completions')) {
    return {
      py: 'client.chat.completions.create(**payload)',
      node: 'client.chat.completions.create(payload)',
      raw: '/chat/completions',
    };
  }
  if (path.endsWith('/images/generations')) {
    return {
      py: 'client.images.generate(**payload)',
      node: 'client.images.generate(payload)',
      raw: '/images/generations',
    };
  }
  if (path.endsWith('/embeddings')) {
    return {
      py: 'client.embeddings.create(**payload)',
      node: 'client.embeddings.create(payload)',
      raw: '/embeddings',
    };
  }
  // responses / messages 等没有 typed helper，走 SDK 的通用 POST
  const relative = path.replace(/^\/v1/, '');
  return {
    py: `client.post(${JSON.stringify(relative)}, body=payload, cast_to=dict)`,
    node: `client.post(${JSON.stringify(relative)}, { body: payload })`,
    raw: relative,
  };
}

/** shell 单引号内转义：' → '\'' */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 双引号内转义：把 " \ $ ` 变成字面量，防止真实 Key 里的元字符逃逸出引号。 */
function shellDoubleQuote(value: string): string {
  return value.replace(/[\\"$`]/g, (char) => `\\${char}`);
}

function pyLiteral(value: unknown, indent = 0): string {
  const pad = '    '.repeat(indent);
  const inner = '    '.repeat(indent + 1);

  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'None';
  if (typeof value === 'string') return JSON.stringify(value);

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const items = value.map((item) => `${inner}${pyLiteral(item, indent + 1)}`);
    return `[\n${items.join(',\n')},\n${pad}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return '{}';
  const lines = entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${pyLiteral(item, indent + 1)}`);
  return `{\n${lines.join(',\n')},\n${pad}}`;
}

export function renderCurl(input: SnippetInput): string {
  // 占位符 $PORTAL_KEY 必须在双引号里保持可展开；真实 Key 则做双引号转义。
  const key = input.apiKey ? shellDoubleQuote(input.apiKey) : KEY_PLACEHOLDER;
  const json = JSON.stringify(input.body);

  return [
    `curl -X ${'POST'} ${shellQuote(joinUrl(input.baseUrl, input.path))} \\`,
    `  -H "Authorization: Bearer ${key}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d ${shellQuote(json)}`,
  ].join('\n');
}

export function renderPython(input: SnippetInput): string {
  const key = input.apiKey ? JSON.stringify(input.apiKey) : 'os.environ.get("PORTAL_KEY", "")';
  const call = sdkCall(input.path);

  return [
    'import os',
    'from openai import OpenAI',
    '',
    `client = OpenAI(base_url=${JSON.stringify(joinUrl(input.baseUrl, '/v1'))}, api_key=${key})`,
    '',
    `payload = ${pyLiteral(input.body)}`,
    '',
    `resp = ${call.py}`,
    'print(resp)',
  ].join('\n');
}

export function renderNode(input: SnippetInput): string {
  const key = input.apiKey ? JSON.stringify(input.apiKey) : 'process.env.PORTAL_KEY';
  const call = sdkCall(input.path);

  return [
    "import OpenAI from 'openai';",
    '',
    `const client = new OpenAI({ baseURL: ${JSON.stringify(joinUrl(input.baseUrl, '/v1'))}, apiKey: ${key} });`,
    '',
    `const payload = ${JSON.stringify(input.body, null, 2)};`,
    '',
    `const resp = await ${call.node};`,
    'console.log(resp);',
  ].join('\n');
}
