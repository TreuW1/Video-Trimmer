/**
 * Tauri API utilities
 * 
 * This file provides helper functions for interacting with the Tauri backend.
 * Import functions as needed in your components.
 * 
 * Note: For file dialogs and file system access, you'll need to install
 * the appropriate Tauri plugins (@tauri-apps/plugin-dialog, @tauri-apps/plugin-fs)
 * and configure them in your Rust backend.
 */

import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Check if the app is running in Tauri
 */
export function isTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Invoke a Rust command
 * 
 * In your Rust code (src-tauri/src/lib.rs), you can create commands like:
 * 
 * #[tauri::command]
 * fn greet(name: &str) -> String {
 *   format!("Hello, {}! You've been greeted from Rust!", name)
 * }
 * 
 * Then call it from the frontend:
 * const result = await invokeTauriCommand('greet', { name: 'World' });
 */
export async function invokeTauriCommand<T = any>(
	command: string,
	args?: Record<string, any>
): Promise<T> {
	if (!isTauri()) {
		throw new Error('Tauri API is not available. This function can only be called in a Tauri app.');
	}
	return invoke<T>(command, args);
}

/**
 * Window management utilities
 */
export const windowUtils = {
	minimize: async () => {
		if (isTauri()) {
			const window = getCurrentWindow();
			await window.minimize();
		}
	},
	maximize: async () => {
		if (isTauri()) {
			const window = getCurrentWindow();
			await window.toggleMaximize();
		}
	},
	close: async () => {
		if (isTauri()) {
			const window = getCurrentWindow();
			await window.close();
		}
	},
	setFullscreen: async (fullscreen: boolean) => {
		if (isTauri()) {
			const window = getCurrentWindow();
			await window.setFullscreen(fullscreen);
		}
	}
};

