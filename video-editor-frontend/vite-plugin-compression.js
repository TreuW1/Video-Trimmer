import { defineConfig } from 'vite';
import { compression } from 'vite-plugin-compression2';

export function compressionPlugin() {
  return compression({
    algorithms: ['gzip'],
    exclude: [/\.(jpg|jpeg|png|gif|webp|svg|ico)$/i],
    threshold: 1024, // Only compress files larger than 1KB
  });
}