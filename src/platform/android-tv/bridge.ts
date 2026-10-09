// platform/android-tv/bridge.ts —— 原生宿主桥接（WebView addJavascriptInterface）
// 对应设计文档 §12：TS 侧通过 window.AndroidWallpaper 调用 Kotlin 注入的原生能力。

import type { DeviceInfo } from '../types';

/**
 * 原生侧需注入到 WebView 的对象（由 Kotlin @JavascriptInterface 提供）。
 * 所有方法同步返回字符串（JSON / base64），便于 WebView 线程内调用。
 */
export interface NativeBridge {
  /** WebDAV 请求：原生侧持有凭证与证书引脚、处理 TLS；返回 JSON {status,headers,base64} */
  davRequest(url: string, method: string, headersJson: string, body: string | null): string;
  /** 持久化 NAS 凭证（Keystore 加密），入参为 JSON */
  saveCredential(json: string): void;
  loadCredential(): string | null;
  clearCredential(): void;
  /** 保持屏幕常亮 */
  keepAwake(on: boolean): void;
  getDeviceInfo(): string;
  /** 内容寻址 blob 存储（App 私有目录），供壁纸缓存落盘 */
  saveBlob(key: string, base64: string): void;
  loadBlob(key: string): string | null;
  blobSize(): number;
  evictBlobs(quotaBytes: number): void;
  /** 日志回传原生 Logcat */
  log(level: string, msg: string): void;
}

/** 读取 WebView 上的原生桥；非 Android 环境（浏览器/测试）返回 null */
export function getNativeBridge(): NativeBridge | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AndroidWallpaper?: NativeBridge };
  return w.AndroidWallpaper ?? null;
}

/** 供宿主实现上报日志（有桥走原生，否则 console） */
export function bridgeLog(bridge: NativeBridge | null, level: 'd' | 'i' | 'w' | 'e', msg: string): void {
  if (bridge) bridge.log(level, msg);
  else if (level === 'e') console.error('[tv-wallpaper]', msg);
  else console.log('[tv-wallpaper]', msg);
}

export type { DeviceInfo };
