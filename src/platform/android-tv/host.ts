// platform/android-tv/host.ts —— Android TV 平台宿主
// 对应设计文档 §12：把原生能力包装为统一 PlatformHost。

import type { DeviceInfo, PlatformHost, RemoteKeyHandler } from '../types';
import { bridgeLog, type NativeBridge } from './bridge';

export class AndroidTvHost implements PlatformHost {
  readonly kind = 'android-tv' as const;

  constructor(private readonly bridge: NativeBridge | null) {}

  /** 保持屏幕常亮（壁纸常驻）。无原生桥时为 no-op。 */
  keepAwake(on: boolean): void {
    if (this.bridge) this.bridge.keepAwake(on);
    else bridgeLog(this.bridge, 'i', `keepAwake(${on}) [noop: 无原生桥]`);
  }

  getDeviceInfo(): DeviceInfo {
    if (this.bridge) {
      try {
        return { os: 'android-tv', ...JSON.parse(this.bridge.getDeviceInfo()) };
      } catch {
        return { os: 'android-tv' };
      }
    }
    // 非原生环境：尽力推断
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';
    return { os: 'android-tv', model: ua };
  }

  /**
   * 订阅遥控器按键。原生环境由 DPad 产生 keydown/keyup；
   * 无原生桥（浏览器调试）时回退到键盘方向键映射。
   */
  onRemoteKey(handler: RemoteKeyHandler): () => void {
    if (typeof window === 'undefined') return () => {};
    const onKey = (e: KeyboardEvent) => {
      const code = mapRemoteKey(e.key, e.code);
      if (!code) return;
      handler({ code, action: e.repeat ? 'repeat' : e.type === 'keyup' ? 'up' : 'down' });
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }
}

/** 将浏览器/系统按键映射为统一遥控事件 code（导出便于单测） */
export function mapRemoteKey(key: string, code: string): string | null {
  switch (key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'Enter':
    case ' ':
      return 'enter';
    case 'Backspace':
    case 'Escape':
      return 'back';
    case 'ContextMenu':
      return 'menu';
    case 'p':
    case 'P':
      return 'play';
  }
  if (code === 'MediaPlayPause') return 'play';
  return null;
}
