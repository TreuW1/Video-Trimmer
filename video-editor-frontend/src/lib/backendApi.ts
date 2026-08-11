import { browser } from '$app/environment';

export const API_BASE = 'http://127.0.0.1:3000';

let tokenPromise: Promise<string> | null = null;

export function getBackendToken(): Promise<string> {
  if (!browser) return Promise.reject(new Error('Backend API is only available in the browser'));
  tokenPromise ??= import('@tauri-apps/api/core')
    .then(({ invoke }) => invoke<string>('get_backend_auth_token'))
    .catch((error) => {
      tokenPromise = null;
      const developmentToken = import.meta.env.VITE_BACKEND_TOKEN;
      if (developmentToken) return developmentToken;
      throw error;
    });
  return tokenPromise;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('X-Video-Trimmer-Token', await getBackendToken());
  return globalThis.fetch(input, { ...init, headers });
}
