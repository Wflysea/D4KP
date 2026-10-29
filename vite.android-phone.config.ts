import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));

// 手机交互层构建：打包为单一 IIFE，与电视版输出到同一 assets/dist 目录。
// 统一 APK 内 index.html 按模式动态加载 android-tv.js / android-phone.js。
// 注意：本构建不清理输出目录（emptyOutDir=false），避免删掉电视版产物；应先构建电视版。
export default defineConfig({
  build: {
    target: 'es2022',
    outDir: 'android/app/src/main/assets/dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(root, 'src/platform/android-tv/entry-phone.ts'),
      output: {
        entryFileNames: 'android-phone.js',
        format: 'iife',
      },
    },
  },
});
