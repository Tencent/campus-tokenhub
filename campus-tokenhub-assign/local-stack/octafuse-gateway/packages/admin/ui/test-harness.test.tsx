/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * UI 测试链路自检（绿色基线 harness）。
 *
 * 证明 4 件事：
 * 1. Vitest 能编译并执行 TSX + ESM 模块；
 * 2. environment=jsdom 提供真实 DOM API；
 * 3. `@/` 别名与 tsconfig paths 一致（`@/ui/test-alias-target` -> `packages/admin/ui/test-alias-target.ts`）；
 * 4. jest-dom matcher 已在 setupFiles 中注册。
 *
 * 不引用任何业务页面/组件/接口，避免把基建验证误当业务断言。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TEST_ALIAS_VALUE } from '@/ui/test-alias-target';

function HarnessButton() {
	return (
		<button type="button" data-testid="harness-button">
			{`harness ${TEST_ALIAS_VALUE}`}
		</button>
	);
}

describe('admin UI test harness', () => {
	it('provides a DOM environment', () => {
		const el = document.createElement('div');
		el.textContent = 'dom-ok';

		expect(el.textContent).toBe('dom-ok');
		expect(window).toBeDefined();
	});

	it('renders TSX and applies jest-dom matchers', () => {
		render(<HarnessButton />);

		const button = screen.getByTestId('harness-button');

		expect(button).toBeInTheDocument();
		expect(button).toHaveTextContent('harness alias-ok');
		expect(button).toBeVisible();
	});

	it('resolves the admin @/ alias from tsconfig paths', () => {
		expect(TEST_ALIAS_VALUE).toBe('alias-ok');
	});
});
