/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/globals.css';
import App from './App';

const rootElement = document.getElementById('root');
if (!rootElement) {
	throw new Error('Admin UI root element #root is missing');
}

createRoot(rootElement).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
