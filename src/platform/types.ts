// platform/types.ts —— 平台能力抽象（多端共用）
// 对应设计文档 §12 平台桥接：把“屏幕常亮 / 设备信息 / 遥控输入 / 凭据安全存储”
// 抽成接口，Android TV / webOS / Tizen / PWA 各自实现，核心层保持纯逻辑。

export type PlatformKind = 'android-tv' | 'webos' | 'tizen' | 'browser';

export interface ScreenInfo {
  width: number;
  height: number;
  dpi: number;
}

export interface DeviceInfo {
  os: PlatformKind;
  model?: string;
  sdkVersion?: string;
  appVersion?: string;
  screen?: ScreenInfo;
}

/** 遥控器/方向键事件：Android TV 的 DPad、webOS Magic Remote、Tizen 方向键统一映射 */
export interface RemoteKeyEvent {
  code: string; // 'up' | 'down' | 'left' | 'right' | 'enter' | 'back' | 'menu' | 'play'
  action: 'down' | 'up' | 'repeat';
}

export type RemoteKeyHandler = (e: RemoteKeyEvent) => void;

/** 平台宿主能力：省电/息屏、设备信息、遥控输入 */
export interface PlatformHost {
  readonly kind: PlatformKind;
  /** 保持屏幕常亮（壁纸常驻），Android 侧对应 WAKE_LOCK */
  keepAwake(on: boolean): void;
  getDeviceInfo(): DeviceInfo;
  /** 订阅遥控器按键，返回取消订阅函数 */
  onRemoteKey(handler: RemoteKeyHandler): () => void;
}

/** 持久化的 NAS 凭证（明文仅存于内存，落盘由原生加密） */
export interface StoredCredential {
  accountId: string;
  server: string;
  rootPath: string;
  username: string;
  password: string;
  https: boolean;
  verifySsl: boolean;
  certFingerprint?: string;
  /** 自动更换壁纸间隔（秒）；缺省 15 */
  dwellSec?: number;
}

/** 凭据保险箱：在原生安全存储（Android Keystore / iOS Keychain）中持久化凭证 */
export interface CredentialVault {
  save(cred: StoredCredential): Promise<void>;
  load(): Promise<StoredCredential | null>;
  clear(): Promise<void>;
}

// ---- base64 编解码（浏览器 btoa/atob 与 Node 22 全局均可用）----

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
