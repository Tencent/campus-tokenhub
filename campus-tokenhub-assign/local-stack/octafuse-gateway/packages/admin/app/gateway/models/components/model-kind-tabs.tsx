'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import { useTranslations } from 'next-intl';
import type { ModelListKindFilter } from '../types';

type KindCounts = { llm: number; image: number; asr: number; tts: number; embedding: number };

type Props = {
	selectedKind: ModelListKindFilter;
	kindCounts: KindCounts;
	/** Kind「All」计数（已应用现役/退役筛选）。 */
	kindAllCount: number;
	onSelectKind: (kind: ModelListKindFilter) => void;
};

/**
 * 模型类型页签：把「类型」从筛选胶囊提升为页面级 tab 展示。
 * 计数随现役/退役/厂商筛选实时更新；窄屏横向滚动，键盘 ←/→/Home/End 切换（与 MCP 页签一致）。
 */
export function ModelKindTabs({ selectedKind, kindCounts, kindAllCount, onSelectKind }: Props) {
	const t = useTranslations('models.filter');
	const tFilter = useTranslations('filter');

	const options: Array<{ value: ModelListKindFilter; label: string; count: number }> = [
		{ value: 'all', label: tFilter('all'), count: kindAllCount },
		{ value: 'llm', label: t('kindLlm'), count: kindCounts.llm },
		{ value: 'image', label: t('kindImage'), count: kindCounts.image },
		{ value: 'asr', label: t('kindAsr'), count: kindCounts.asr },
		{ value: 'tts', label: t('kindTts'), count: kindCounts.tts },
		{ value: 'embedding', label: t('kindEmbedding'), count: kindCounts.embedding },
	];

	return (
		<div role="tablist" aria-label={t('kindAria')} className="mb-4 flex min-w-0 gap-6 overflow-x-auto border-b border-slate-200">
			{options.map((option, index) => {
				const isActive = selectedKind === option.value;
				const isEmpty = option.count === 0 && !isActive;
				return (
					<button
						key={option.value}
						id={`model-kind-tab-${option.value}`}
						type="button"
						role="tab"
						aria-selected={isActive}
						tabIndex={isActive ? 0 : -1}
						onClick={() => onSelectKind(option.value)}
						onKeyDown={(event) => {
							let nextIndex: number;
							switch (event.key) {
								case 'ArrowRight': nextIndex = (index + 1) % options.length; break;
								case 'ArrowLeft': nextIndex = (index + options.length - 1) % options.length; break;
								case 'Home': nextIndex = 0; break;
								case 'End': nextIndex = options.length - 1; break;
								default: return;
							}
							event.preventDefault();
							const next = options[nextIndex].value;
							onSelectKind(next);
							document.getElementById(`model-kind-tab-${next}`)?.focus();
						}}
						className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
							isActive
								? 'border-gray-900 text-gray-900'
								: 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
						} ${isEmpty ? 'opacity-60' : ''}`}
					>
						{option.label}
						<span
							className={`rounded-full px-1.5 text-[11px] leading-4 tabular-nums ${
								isActive ? 'bg-slate-200 text-slate-700' : 'bg-slate-100 text-slate-500'
							}`}
						>
							{option.count}
						</span>
					</button>
				);
			})}
		</div>
	);
}
