// platform/android-tv/entry-phone.ts —— 手机端引导（触摸 / 滑动输入）
// 复用与电视完全相同的共用内核（boot-core.ts），仅把输入源换成触摸手势：
//   轻点 / 上滑 / 左滑 → 下一帧；右滑 → 上一帧；下滑 → 打开设置

import { bootWallpaperApp } from './boot-core';

if (typeof document !== 'undefined') {
  const start = () => {
    void bootWallpaperApp().then(({ nav }) => {
      let sx = 0;
      let sy = 0;
      document.addEventListener(
        'touchstart',
        (e: TouchEvent) => {
          sx = e.changedTouches[0].clientX;
          sy = e.changedTouches[0].clientY;
        },
        { passive: true },
      );
      document.addEventListener(
        'touchend',
        (e: TouchEvent) => {
          const dx = e.changedTouches[0].clientX - sx;
          const dy = e.changedTouches[0].clientY - sy;
          const adx = Math.abs(dx);
          const ady = Math.abs(dy);
          if (adx < 30 && ady < 30) {
            nav.next(); // 轻点：下一帧
            return;
          }
          if (adx > ady) {
            if (dx < 0) nav.next();
            else nav.prev();
          } else if (dy < 0) {
            nav.next(); // 上滑：下一帧
          } else {
            nav.openSettings(); // 下滑：打开设置
          }
        },
        { passive: true },
      );
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
}
