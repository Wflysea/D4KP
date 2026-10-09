// platform/android-tv/entry.ts —— Android TV 引导（遥控器输入）
// 共用内核见 boot-core.ts；本文件仅负责把遥控器按键映射到导航句柄。

import { bootWallpaperApp } from './boot-core';

export async function bootAndroidTv(root?: HTMLElement): Promise<void> {
  const { app, nav } = await bootWallpaperApp(root);
  app.host.onRemoteKey((e) => {
    if (e.action !== 'down') return;
    if (e.code === 'menu' || e.code === 'back') {
      nav.openSettings();
      return;
    }
    // OK 键 / 媒体播放键：暂停或恢复自动轮播
    if (e.code === 'enter' || e.code === 'play') {
      nav.togglePause();
      return;
    }
    if (e.code === 'right' || e.code === 'down') nav.next();
    else if (e.code === 'left' || e.code === 'up') nav.prev();
  });

  // 暴露给原生层：遥控器菜单键（KEYCODE_MENU）被系统拦截，无法作为 DOM 事件到达 WebView，
  // 因此由 MainActivity 直接调用此全局函数重新打开设置，避免依赖合成按键与键位映射。
  (window as unknown as Record<string, unknown>).__tvOpenSettings = () => nav.openSettings();
}

// WebView 内加载后自动引导（仅在浏览器/DOM 环境执行）
if (typeof document !== 'undefined') {
  const start = () => void bootAndroidTv();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
