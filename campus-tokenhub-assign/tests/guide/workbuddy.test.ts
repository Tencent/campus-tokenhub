import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildWorkBuddyDownload,
  buildWorkBuddyEntry,
  buildWorkBuddyFetchCommand,
  buildWorkBuddyScript,
  buildWorkBuddyScriptUrl,
  WORKBUDDY_DOWNLOAD,
} from '@/lib/guide/workbuddy';

const BASE_INPUT = {
  modelId: 'qwen3-235b-a22b',
  modelName: '通义千问3 235B',
  endpoint: 'https://api.school.edu.cn/tokenhub/v1/chat/completions',
  apiKey: 'sk-test-123',
  supportsImages: true,
  maxInputTokens: 131072,
  maxOutputTokens: 8192,
};

/** mac 脚本把模型 JSON 放在 heredoc 里，取出来单独校验 */
function extractMacPayload(script: string): unknown {
  const start = script.indexOf("<<'WORKBUDDY_MODELS_JSON'\n");
  const end = script.indexOf('\nWORKBUDDY_MODELS_JSON\n', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(script.slice(start + "<<'WORKBUDDY_MODELS_JSON'\n".length, end));
}

function extractWindowsPayload(script: string): unknown {
  const start = script.indexOf("$payloadRaw = @'\n");
  const end = script.indexOf("\n'@\n", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return JSON.parse(script.slice(start + "$payloadRaw = @'\n".length, end));
}

describe('buildWorkBuddyEntry', () => {
  it('按 WorkBuddy 自定义模型的字段写，不瞎猜能力', () => {
    expect(buildWorkBuddyEntry(BASE_INPUT)).toEqual({
      id: 'qwen3-235b-a22b',
      name: '通义千问3 235B',
      vendor: 'Custom',
      url: 'https://api.school.edu.cn/tokenhub/v1/chat/completions',
      apiKey: 'sk-test-123',
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: false,
      useCustomProtocol: false,
      maxInputTokens: 131072,
      maxOutputTokens: 8192,
    });
  });

  it('模型支持深度思考时如实写 supportsReasoning: true', () => {
    const entry = buildWorkBuddyEntry({ ...BASE_INPUT, supportsReasoning: true });
    expect(entry.supportsReasoning).toBe(true);
  });

  it('没有展示名时退回模型 ID，目录读不到长度就不写这两个字段', () => {
    const entry = buildWorkBuddyEntry({
      modelId: 'deepseek-v4-flash',
      modelName: '   ',
      endpoint: BASE_INPUT.endpoint,
      apiKey: BASE_INPUT.apiKey,
      maxInputTokens: null,
      maxOutputTokens: 0,
    });

    expect(entry.name).toBe('deepseek-v4-flash');
    expect(entry.supportsImages).toBe(false);
    expect('maxInputTokens' in entry).toBe(false);
    expect('maxOutputTokens' in entry).toBe(false);
  });
});

describe('buildWorkBuddyScript', () => {
  const entry = buildWorkBuddyEntry(BASE_INPUT);

  it('mac 脚本里的模型 JSON 可以原样解析', () => {
    expect(extractMacPayload(buildWorkBuddyScript('mac', [entry]))).toEqual([entry]);
  });

  it('windows 脚本里的模型 JSON 可以原样解析', () => {
    expect(extractWindowsPayload(buildWorkBuddyScript('windows', [entry]))).toEqual([entry]);
  });

  it('Key 里带引号、美元符号和反斜杠也不会破坏脚本', () => {
    const tricky = buildWorkBuddyEntry({
      ...BASE_INPUT,
      modelName: `含"引号"和$VAR与\\反斜杠`,
      apiKey: `sk-'quote'-"dquote"-$HOME-\\`,
    });

    for (const platform of ['mac', 'windows'] as const) {
      const script = buildWorkBuddyScript(platform, [tricky]);
      const payload = platform === 'mac' ? extractMacPayload(script) : extractWindowsPayload(script);
      expect(payload).toEqual([tricky]);
      // 这里若被截断，说明 heredoc 被内容提前闭合了
      expect(script).toContain('下一步：完全退出 WorkBuddy');
    }
  });

  it('多个模型会一次全部写进脚本', () => {
    const second = buildWorkBuddyEntry({
      ...BASE_INPUT,
      modelId: 'deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      supportsImages: false,
      maxInputTokens: 1024000,
      maxOutputTokens: 348000,
    });
    const entries = [entry, second];

    for (const platform of ['mac', 'windows'] as const) {
      const script = buildWorkBuddyScript(platform, entries);
      const payload = platform === 'mac' ? extractMacPayload(script) : extractWindowsPayload(script);
      expect(payload).toEqual(entries);
      expect(script).toContain('把 2 个模型合并进');
    }
  });

  it('方式一的脚本地址与命令自带下载地址', () => {
    const base = 'https://portal.test/tokenhub/portal';
    const all = buildWorkBuddyScriptUrl(base, 'mac', []);
    const picked = buildWorkBuddyScriptUrl(base, 'windows', ['glm-5.3', 'deepseek/v4']);

    expect(all).toBe(`${base}/api/portal/workbuddy/script?platform=mac`);
    expect(picked).toBe(`${base}/api/portal/workbuddy/script?platform=windows&models=glm-5.3,deepseek%2Fv4`);

    const mac = buildWorkBuddyFetchCommand('mac', all, 'sk-test-123');
    expect(mac).toContain("curl -fsSL -H 'X-Api-Key: sk-test-123'");
    expect(mac).toContain(all);
    expect(mac.endsWith('| bash')).toBe(true);

    const windows = buildWorkBuddyFetchCommand('windows', picked, 'sk-test-123');
    expect(windows).toContain('-ExecutionPolicy Bypass');
    expect(windows).toContain("@{'X-Api-Key'='sk-test-123'}");
    expect(windows).toContain(picked);
    expect(windows.endsWith('| iex"')).toBe(true);
  });

  it('Key 里的单引号会被转义，跳不出引号（防命令注入）', () => {
    // 「方式一」是把这条命令整段粘进终端执行的：Key 里出现 `'` 且不转义，
    // 后面跟的内容就会被 shell 当成命令跑。
    const key = "sk-a'; touch /tmp/pwn; '";
    const url = 'https://portal.test/api/portal/workbuddy/script?platform=mac';

    const mac = buildWorkBuddyFetchCommand('mac', url, key);
    expect(mac).not.toContain("X-Api-Key: sk-a'; touch");
    expect(mac).toContain("X-Api-Key: sk-a'\\''; touch /tmp/pwn; '\\'''");

    const windows = buildWorkBuddyFetchCommand('windows', url, key);
    expect(windows).not.toContain("'X-Api-Key'='sk-a'; touch");
    expect(windows).toContain("'X-Api-Key'='sk-a''; touch /tmp/pwn; '''");
  });

  it('两个平台的路径与命令与说明一致', () => {
    const mac = buildWorkBuddyScript('mac', [entry]);
    const windows = buildWorkBuddyScript('windows', [entry]);

    expect(mac).toContain('CONFIG_FILE="$CONFIG_DIR/models.json"');
    expect(mac).toContain('CONFIG_DIR="$HOME/.workbuddy"');
    expect(windows).toContain("Join-Path $homeDir '.workbuddy'");
    expect(windows).toContain("Join-Path $configDir 'models.json'");
    // PowerShell 5.1 写 UTF8 会带 BOM，JSON.parse 会因此失败，必须用无 BOM 写入
    expect(windows).toContain('UTF8Encoding($false)');

    expect(WORKBUDDY_DOWNLOAD.mac.fileName).toBe('workbuddy-connect-mac.zip');
    expect(WORKBUDDY_DOWNLOAD.mac.innerFileName).toBe('workbuddy-connect.command');
    expect(WORKBUDDY_DOWNLOAD.windows.fileName.endsWith('.ps1')).toBe(true);
    // PS 5.1 没有 BOM 时会按 ANSI 解码，中文模型名会乱码落盘
    expect(windows.startsWith('\uFEFF')).toBe(true);
    expect(mac.startsWith('\uFEFF')).toBe(false);
  });
});

describe('buildWorkBuddyDownload', () => {
  const entry = buildWorkBuddyEntry(BASE_INPUT);

  /** zip 中央目录里的 external attrs 高 16 位就是 Unix 权限位 */
  function centralMode(bytes: Uint8Array): number {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let index = 0; index < bytes.length - 4; index += 1) {
      if (view.getUint32(index, true) === 0x02014b50) return view.getUint32(index + 38, true) >>> 16;
    }
    throw new Error('没有找到 zip 中央目录');
  }

  it('mac 下载的是 zip，内含 755 的 .command 与完整脚本', () => {
    const download = buildWorkBuddyDownload('mac', [entry]);
    const text = new TextDecoder().decode(download.bytes);

    expect(download.fileName).toBe('workbuddy-connect-mac.zip');
    expect(download.mimeType).toBe('application/zip');
    expect(Array.from(download.bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    // 高 16 位里还带着 0x8000（普通文件）标志，只看低 9 位权限
    expect(centralMode(download.bytes) & 0o777).toBe(0o755);
    // store 模式，脚本内容在包里是明文，能直接搜到
    expect(text).toContain('workbuddy-connect.command');
    expect(text).toContain(buildWorkBuddyScript('mac', [entry]));
  });

  it('windows 仍是纯文本 ps1（带 BOM）', () => {
    const download = buildWorkBuddyDownload('windows', [entry]);
    expect(download.fileName).toBe('workbuddy-connect-windows.ps1');
    expect(download.mimeType).toContain('text/plain');
    // ignoreBOM: true 才会把 BOM 也解出来，默认会被 TextDecoder 吃掉
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(download.bytes)).toBe(
      buildWorkBuddyScript('windows', [entry])
    );
  });

  it.skipIf(!existsSync('/usr/bin/unzip'))('解压后文件带执行权限（可直接双击）', () => {
    const entries = [entry, buildWorkBuddyEntry({ ...BASE_INPUT, modelId: 'deepseek-v4-flash' })];
    const download = buildWorkBuddyDownload('mac', entries);
    const workDir = mkdtempSync(join(tmpdir(), 'workbuddy-unzip-'));
    const zipPath = join(workDir, 'bundle.zip');
    writeFileSync(zipPath, download.bytes);

    execFileSync('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', workDir]);

    const scriptPath = join(workDir, 'workbuddy-connect.command');
    expect(statSync(scriptPath).mode & 0o777).toBe(0o755);
    expect(readFileSync(scriptPath, 'utf8')).toBe(buildWorkBuddyScript('mac', entries));
  });
});

describe.skipIf(process.platform === 'win32')('mac 脚本实跑', () => {
  function runInSandbox(script: string, existing?: unknown) {
    const home = mkdtempSync(join(tmpdir(), 'workbuddy-home-'));
    if (existing !== undefined) {
      mkdirSync(join(home, '.workbuddy'), { recursive: true });
      writeFileSync(join(home, '.workbuddy/models.json'), JSON.stringify(existing, null, 2), 'utf8');
    }
    const scriptPath = join(home, 'setup.sh');
    writeFileSync(scriptPath, script, 'utf8');

    const output = execFileSync('/bin/bash', [scriptPath], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });

    const configFile = join(home, '.workbuddy/models.json');
    return {
      output,
      home,
      configFile,
      models: JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>[],
    };
  }

  it('目录不存在时自动创建并写入', () => {
    const entry = buildWorkBuddyEntry(BASE_INPUT);
    const { models, output } = runInSandbox(buildWorkBuddyScript('mac', [entry]));

    expect(models).toEqual([entry]);
    expect(output).toContain('共 1 个模型');
  });

  it('保留别人的模型、同 ID 覆盖、并留下备份', () => {
    const entry = buildWorkBuddyEntry(BASE_INPUT);
    const other = { id: 'another-model', name: '别的模型', url: 'https://example.com/v1/chat/completions' };
    const stale = { ...entry, apiKey: 'sk-old' };

    const { models, home, configFile, output } = runInSandbox(buildWorkBuddyScript('mac', [entry]), [other, stale]);

    expect(models.map((model) => model.id)).toEqual(['another-model', entry.id]);
    expect(models[1].apiKey).toBe(entry.apiKey);
    expect(output).toContain('共 2 个模型');
    expect(existsSync(configFile)).toBe(true);
    expect(readdirSync(join(home, '.workbuddy')).some((name) => name.startsWith('models.json.bak-'))).toBe(true);
  });

  it('一次写入多个模型：同 ID 覆盖、新的追加、顺序稳定', () => {
    const first = buildWorkBuddyEntry(BASE_INPUT);
    const second = buildWorkBuddyEntry({ ...BASE_INPUT, modelId: 'deepseek-v4-flash', modelName: 'DeepSeek V4 Flash' });
    const other = { id: 'another-model', name: '别的模型', url: 'https://example.com/v1/chat/completions' };
    const stale = { ...first, apiKey: 'sk-old' };

    const { models, output } = runInSandbox(buildWorkBuddyScript('mac', [first, second]), [other, stale]);

    expect(models.map((model) => model.id)).toEqual(['another-model', first.id, second.id]);
    expect(models[1].apiKey).toBe(first.apiKey);
    expect(output).toContain('共 3 个模型');
  });

  it('取消勾选后重跑：门户写过的模型被移除，别的来源保留', () => {
    const keptEntry = buildWorkBuddyEntry(BASE_INPUT);
    // 上次导入过、这次没勾：同一接口地址、不同 id
    const unselected = buildWorkBuddyEntry({ ...BASE_INPUT, modelId: 'glm-5.3', modelName: 'GLM-5.3' });
    const other = { id: 'another-model', name: '别的模型', url: 'https://example.com/v1/chat/completions' };

    const { models, output } = runInSandbox(buildWorkBuddyScript('mac', [keptEntry]), [other, unselected]);

    expect(models.map((model) => model.id)).toEqual(['another-model', keptEntry.id]);
    expect(output).toContain('共 2 个模型');
  });

  it('现有文件损坏时停止写入，不覆盖原内容', () => {
    const entry = buildWorkBuddyEntry(BASE_INPUT);
    const home = mkdtempSync(join(tmpdir(), 'workbuddy-home-'));
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const configFile = join(home, '.workbuddy/models.json');
    writeFileSync(configFile, '[{"id": ', 'utf8');
    const scriptPath = join(home, 'setup.sh');
    writeFileSync(scriptPath, buildWorkBuddyScript('mac', [entry]), 'utf8');

    expect(() =>
      execFileSync('/bin/bash', [scriptPath], { env: { ...process.env, HOME: home }, stdio: 'pipe' })
    ).toThrow();
    expect(readFileSync(configFile, 'utf8')).toBe('[{"id": ');
  });
});
