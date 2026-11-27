/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台 SPA 构建（design D3/D4/D5）。
 *
 * - 唯一 React/lazy 绑定在 `ui/routes.tsx`，Node 不引用本配置；
 * - `ADMIN_UI_PUBLIC_PATH` 只影响 `base`（浏览器侧），非法值在构建期直接失败；
 * - 构建产物输出到 `packages/admin/ui-dist`，Node dispatch 直接读取；
 * - 每次构建生成一个非敏感 build ID：同一个值注入入口 JS 并写入
 *   `ui-dist/ui-version.json`，供旧标签页做一次有界版本核对。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import autoprefixer from 'autoprefixer';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import { defineConfig, type Plugin } from 'vite';
import { createAdminPublicPath } from './lib/admin-public-path';

const ADMIN_ROOT = fileURLToPath(new URL('.', import.meta.url));
// 非法前缀（协议、host、query/hash、`..`）在这里直接抛错，不产出错误 base 的产物。
const publicPath = createAdminPublicPath(process.env.ADMIN_UI_PUBLIC_PATH);

/** 可由 CI 显式注入（如提交短 SHA），否则每次构建生成一个随机 ID。 */
const buildId =
	process.env.ADMIN_UI_BUILD_ID?.trim() || `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

/** 与入口同 build 的版本元数据；只含 build ID 与前端前缀，不含任何环境/凭证信息。 */
function adminUiVersionPlugin(id: string): Plugin {
	return {
		name: 'octafuse-admin-ui-version',
		apply: 'build',
		writeBundle(options) {
			const outDir = options.dir ?? path.join(ADMIN_ROOT, 'ui-dist');
			mkdirSync(outDir, { recursive: true });
			writeFileSync(
				path.join(outDir, 'ui-version.json'),
				// `publicPath` 供容器启动时自检：镜像里的前端前缀必须与运行期
				// `ADMIN_UI_PUBLIC_PATH` 一致，否则浏览器会去根路径取资源（4.4 C1）。
				`${JSON.stringify({ buildId: id, publicPath: publicPath.base })}\n`,
			);
		},
	};
}

export default defineConfig({
	root: path.join(ADMIN_ROOT, 'ui'),
	base: publicPath.viteBase,
	define: {
		__ADMIN_UI_BUILD_ID__: JSON.stringify(buildId),
		__ADMIN_UI_PUBLIC_BASE__: JSON.stringify(publicPath.base),
	},
	plugins: [react(), adminUiVersionPlugin(buildId)],
	resolve: {
		alias: [
			{ find: /^@\//, replacement: `${ADMIN_ROOT}/` },
			{ find: /^next\/link$/, replacement: path.join(ADMIN_ROOT, 'ui/link.tsx') },
			{ find: /^next\/navigation$/, replacement: path.join(ADMIN_ROOT, 'ui/navigation.ts') },
		],
	},
	css: {
		postcss: {
			plugins: [
				tailwindcss({ config: path.join(ADMIN_ROOT, 'tailwind.config.ts') }),
				autoprefixer(),
			],
		},
	},
	build: {
		outDir: path.join(ADMIN_ROOT, 'ui-dist'),
		emptyOutDir: true,
		manifest: true,
		rollupOptions: {
			input: path.join(ADMIN_ROOT, 'ui/index.html'),
		},
	},
});