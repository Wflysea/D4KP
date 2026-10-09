import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

// 手机版 WebView 宿主构建：打包为单一 IIFE，注入手机模块 assets/dist 目录。
// 与电视版共用同一套 TS 内核（boot-core.ts），仅入口切换为触摸导航（entry-phone.ts）。
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'android/app-phone/src/main/assets/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, 'src/platform/android-tv/entry-phone.ts'),
      output: {
        entryFileNames: 'android-phone.js',
        format: 'iife',
      },
    },
  },
});
