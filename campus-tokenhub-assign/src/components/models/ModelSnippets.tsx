'use client';

import { useEffect, useMemo, useState } from 'react';
import { CopyButton } from '@/components/ui/CopyButton';
import { loadActiveKey } from '@/lib/portal/key-cache';
import { renderCurl, renderNode, renderPython } from '@/lib/playground/snippets';

type Tab = 'curl' | 'python' | 'node';

const TABS: { key: Tab; label: string }[] = [
  { key: 'curl', label: 'cURL' },
  { key: 'python', label: 'Python' },
  { key: 'node', label: 'Node.js' },
];

export function ModelSnippets({
  baseUrl,
  path,
  body,
}: {
  baseUrl: string;
  path: string;
  body: Record<string, unknown>;
}) {
  const [tab, setTab] = useState<Tab>('curl');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // Key 只在客户端按需拉取，不写进 SSR HTML；与调试台共用内存缓存
  useEffect(() => {
    let cancelled = false;
    loadActiveKey().then((result) => {
      if (cancelled) return;
      if (result.ok) setApiKey(result.key);
      else setKeyError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const code = useMemo(() => {
    const input = { baseUrl, path, body, apiKey: showKey ? apiKey : null };
    if (tab === 'python') return renderPython(input);
    if (tab === 'node') return renderNode(input);
    return renderCurl(input);
  }, [apiKey, baseUrl, body, path, showKey, tab]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1 rounded-full bg-cream-100 p-1">
          {TABS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              aria-pressed={tab === item.key}
              className={`rounded-full px-3 py-1 text-xs transition ${
                tab === item.key
                  ? 'bg-ink-900 font-medium text-white shadow-card'
                  : 'text-ink-500 hover:text-ink-900'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-ink-500">
            <input
              type="checkbox"
              checked={showKey}
              onChange={(event) => setShowKey(event.target.checked)}
              disabled={!apiKey}
              className="h-3.5 w-3.5 accent-brand-orange"
            />
            显示我的 Key
          </label>
          <CopyButton value={code} />
        </div>
      </div>

      {showKey && !apiKey && (
        <p className="mt-2 text-xs text-amber-700">{keyError ?? '正在读取密钥…'}</p>
      )}

      <pre className="scroll-x mt-3 rounded-card bg-ink-900 p-4 text-xs leading-relaxed text-slate-100">
        <code>{code}</code>
      </pre>
      <p className="mt-2 text-[11px] text-ink-500">
        示例里的 <code className="font-mono">$PORTAL_KEY</code> 请替换成你自己的密钥；真实调用地址是{' '}
        <code className="font-mono">{baseUrl}/v1</code>。
      </p>
    </div>
  );
}
