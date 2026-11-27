/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台 UI 测试（Vitest + jsdom）。
 *
 * 与 Node 单测（`test:unit`，tsx --test 直列文件）完全分离：
 * - 只收集 `ui/**` 下的 `.test.ts` / `.test.tsx`，不触碰 `lib/`、`app/` 的 Node 用例；
 * - 运行 cwd 必须是 `packages/admin`（由 `npm run test:ui -w @octafuse/admin` 保证），
 *   避免命中仓库根门户的 vitest 配置与 `@ -> src` 别名。
 *
 * `@/` 别名与 `tsconfig.json` 的 `paths` 保持一致：`@/* -> packages/admin/*`。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ADMIN_ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
	esbuild: { jsx: 'automatic' },
	define: {
		// 与 vite.config.ts 的构建期注入保持一致，测试里固定为可断言的稳定值。
		__ADMIN_UI_BUILD_ID__: JSON.stringify('test-build'),
		__ADMIN_UI_PUBLIC_BASE__: JSON.stringify(''),
	},
	resolve: {
		alias: [
			// 必须只匹配 `@/...`，不能用字符串 `@`：`@octafuse/core/...` 不能被改写。
			{ find: /^@\//, replacement: `${ADMIN_ROOT}/` },
			{ find: /^next\/link$/, replacement: `${ADMIN_ROOT}/ui/link.tsx` },
			{ find: /^next\/navigation$/, replacement: `${ADMIN_ROOT}/ui/navigation.ts` },
		],
	},
	test: {
		environment: 'jsdom',
		globals: true,
		include: ['ui/**/*.test.{ts,tsx}'],
		setupFiles: ['./ui/test-setup.ts'],
	},
});
