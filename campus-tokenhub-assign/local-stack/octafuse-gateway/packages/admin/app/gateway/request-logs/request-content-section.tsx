'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 请求日志详情里的「输入 / 输出正文」折叠块。
 *
 * 数据来自 `GET /api/admin/request-logs/:id/content`：
 * - `captured`：正常展示；
 * - `truncated`：分别提示哪一侧被截断；
 * - `missing`：说明「本次调用未留存正文」，与日志不存在区分。
 *
 * 默认折叠，避免把 64 KB 正文一次塞进详情面板。
 */
import { useState } from 'react';
import { adminApiPath } from '@/lib/admin-browser-path';

type RequestContentState = 'captured' | 'truncated' | 'missing';

type RequestContentPayload = {
	requestLogId: string;
	createdAt: string;
	state: RequestContentState;
	inputText: string | null;
	outputText: string | null;
	inputChars: number | null;
	outputChars: number | null;
	inputTruncated: boolean;
	outputTruncated: boolean;
};

type LoadState =
	| { kind: 'idle' }
	| { kind: 'loading' }
	| { kind: 'error'; message: string }
	| { kind: 'ready'; data: RequestContentPayload };

function ContentBlock({
	label,
	text,
	chars,
	truncated,
}: {
	label: string;
	text: string | null;
	chars: number | null;
	truncated: boolean;
}) {
	return (
		<div className="mt-3">
			<div className="flex items-center gap-2 text-[11px] text-slate-500">
				<span className="font-medium text-slate-600">{label}</span>
				{chars != null && <span>{chars} 字符</span>}
				{truncated && <span className="text-amber-600">已截断</span>}
			</div>
			<pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
				{text?.trim() ? text : '（空）'}
			</pre>
		</div>
	);
}

export function RequestContentSection({ requestLogId }: { requestLogId: string }) {
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<LoadState>({ kind: 'idle' });

	async function toggle(): Promise<void> {
		const next = !open;
		setOpen(next);
		if (!next || state.kind !== 'idle') return;

		setState({ kind: 'loading' });
		try {
			const response = await fetch(
				adminApiPath(`/api/admin/request-logs/${encodeURIComponent(requestLogId)}/content`)
			);
			if (!response.ok) {
				setState({ kind: 'error', message: `加载失败（HTTP ${response.status}）` });
				return;
			}
			const data = (await response.json()) as RequestContentPayload;
			setState({ kind: 'ready', data });
		} catch {
			setState({ kind: 'error', message: '加载失败，请稍后重试' });
		}
	}

	return (
		<div className="mt-4 rounded-lg border border-slate-200 bg-white">
			<button
				type="button"
				onClick={() => void toggle()}
				aria-expanded={open}
				className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-medium text-slate-700 hover:bg-slate-50"
			>
				<span>输入 / 输出正文</span>
				<span className="text-slate-400">{open ? '收起' : '展开'}</span>
			</button>

			{open && (
				<div className="border-t border-slate-100 px-3 pb-3">
					{state.kind === 'loading' && <p className="mt-3 text-xs text-slate-500">加载中…</p>}
					{state.kind === 'error' && <p className="mt-3 text-xs text-red-600">{state.message}</p>}
					{state.kind === 'ready' && state.data.state === 'missing' && (
						<p className="mt-3 text-xs text-slate-500">
							本次调用未留存正文（可能未开启捕获、被队列丢弃或写入失败）。
						</p>
					)}
					{state.kind === 'ready' && state.data.state !== 'missing' && (
						<>
							<ContentBlock
								label="输入"
								text={state.data.inputText}
								chars={state.data.inputChars}
								truncated={state.data.inputTruncated}
							/>
							<ContentBlock
								label="输出"
								text={state.data.outputText}
								chars={state.data.outputChars}
								truncated={state.data.outputTruncated}
							/>
						</>
					)}
				</div>
			)}
		</div>
	);
}
