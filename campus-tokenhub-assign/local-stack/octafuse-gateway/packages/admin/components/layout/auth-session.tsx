'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 会话上下文：`AuthWrapper` 是唯一拥有者，`Sidebar` 等子组件只通过这里触发
 * login/logout，不各自发 Cookie 变更请求（design D6）。
 */
import { createContext, useContext } from 'react';
import type { AuthCoordinator, AuthSnapshot } from '@/lib/admin-auth-coordinator';

export interface AuthSessionValue {
	snapshot: AuthSnapshot;
	login: AuthCoordinator['login'];
	logout: AuthCoordinator['logout'];
}

const AuthSessionContext = createContext<AuthSessionValue | null>(null);

export const AuthSessionProvider = AuthSessionContext.Provider;

export function useAuthSession(): AuthSessionValue {
	const value = useContext(AuthSessionContext);
	if (!value) throw new Error('useAuthSession must be used inside the admin AuthWrapper');
	return value;
}
