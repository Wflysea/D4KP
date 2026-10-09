import { defineConfig } from 'vite';

// 多端构建入口：核心层产出 ESM 库，各 TV 端（Android TV / webOS / Tizen）与 Remote PWA 复用。
export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: 'tv-wallpaper-core',
    },
    rollupOptions: {
      external: ['zustand'],
    },
  },
});
