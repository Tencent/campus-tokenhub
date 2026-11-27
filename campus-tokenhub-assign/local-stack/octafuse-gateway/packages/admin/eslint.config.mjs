/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import next from 'eslint-config-next';

// eslint-config-next stays at the existing 16.2.3 rule baseline in package.json;
// adopting React Compiler rules is a separate migration from runtime security fixes.

/** @type {import('eslint').Linter.Config[]} */
const config = [
	...next,
	{
		ignores: [
			'.open-next/**',
			'.wrangler/**',
			'.next/**',
			// 构建产物不是源码；不忽略会让 lint 结果随「是否 build 过」变化。
			'ui-dist/**',
			'node-server-dist/**',
			'cloudflare-env.d.ts',
			'scripts/**',
		],
	},
	{
		rules: {
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['@octafuse/proxy', '@octafuse/proxy/*', '@octafuse/proxy-services', '@octafuse/proxy-services/*'],
							message:
								'Admin must not import @octafuse/proxy. Use @octafuse/tool-engines for Tool engine clients.',
						},
						{
							group: ['**/packages/proxy/**', '../proxy/**', '../../proxy/**'],
							message:
								'Admin must not reach into packages/proxy. Shared Tool engines live in @octafuse/tool-engines.',
						},
					],
				},
			],
		},
	},
];

export default config;
