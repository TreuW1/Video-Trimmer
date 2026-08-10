import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { compressionPlugin } from './vite-plugin-compression';

// Tauri expects a fixed port, fail if that port is not available
const host = process.env.TAURI_DEV_HOST || undefined;
const port = process.env.TAURI_DEV_PORT ? parseInt(process.env.TAURI_DEV_PORT) : 5173;

export default defineConfig(({ mode }) => ({
	plugins: [
		tailwindcss(), 
		sveltekit(),
		compressionPlugin()
	],
	// Tauri uses a fixed port, fail if that port is not available
	server: {
		port: port,
		strictPort: true,
		host: host,
		watch: {
			// Tell vite to ignore watching `src-tauri`
			ignored: ['**/src-tauri/**']
		}
	},
	build: {
		minify: 'terser',
		terserOptions: {
			compress: {
				// Only drop console logs in production builds
				drop_console: mode === 'production',
				drop_debugger: true
			}
		},
		rollupOptions: {
			output: {
				manualChunks: {
					vendor: ['svelte'],
					utils: ['./src/lib/utils']
				}
			}
		}
	},
	// Prevent vite from obscuring rust errors
	clearScreen: false,
	// Tauri expects a fixed port, fail if that port is not available
	envPrefix: ['VITE_', 'TAURI_']
}));