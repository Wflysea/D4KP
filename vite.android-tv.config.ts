import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

// Android TV WebView 宿主构建：把 TS 应用打包为单一 IIFE，注入原生 assets/dist 目录。
// 构建产物由 Kotlin 侧 assets/index.html 通过 ./dist/android-tv.js 引入。
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'android/app/src/main/assets/dist',
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(root, 'src/platform/android-tv/entry.ts'),
      output: {
        entryFileNames: 'android-tv.js',
        format: 'iife',
      },
    },
  },
});
