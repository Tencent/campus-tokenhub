/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 当前 UI 构建的非敏感 build ID（design D5）。
 *
 * - Vite 构建期通过 `define` 注入 `__ADMIN_UI_BUILD_ID__`，同一构建的入口 JS 与
 *   `ui-dist/ui-version.json` 使用同一个值；
 * - 未注入（如 Node/Next 编译、测试环境未定义）时回落为 `dev`，只用 `typeof`
 *   判断，避免在 Next 打包时引用不存在的全局标识符。
 *
 * 不包含提交号以外的任何环境信息，也不含凭证。
 */
declare const __ADMIN_UI_BUILD_ID__: string | undefined;

function resolveAdminUiBuildId(): string {
	const injected = typeof __ADMIN_UI_BUILD_ID__ === 'string' ? __ADMIN_UI_BUILD_ID__.trim() : '';
	return injected || 'dev';
}

export const ADMIN_UI_BUILD_ID = resolveAdminUiBuildId();
