// index.ts —— 库入口与开发环境装配示例
// 对应设计文档 §15 目录结构

import { composeRoot, type AppContext, type PlatformDeps } from './app/compose-root';
import { FetchHttpClient } from './platform/http/fetch';
import { MemoryCatalogStore, MemoryContentCache } from './storage/memory';
import type { DavEndpoint } from './webdav/types';

export * from './types/domain';
export * from './webdav/types';
export { WebdavClient, Semaphore } from './webdav/client';
export { createWebdavClient, recognizeVendor } from './webdav/adapters';
export { SyncEngine } from './core/sync/sync-engine';
export { reducer } from './player/scheduler';
export { resolveActivePlaylist } from './core/playlist/playlist-engine';
export { parseRemoteCommand } from './remote/messages';
export { composeRoot };
export type { AppContext, PlatformDeps };

// 平台能力（多端共用）
export type {
  PlatformHost,
  DeviceInfo,
  CredentialVault,
  StoredCredential,
  RemoteKeyEvent,
} from './platform/types';
export type { NativeBridge } from './platform/android-tv/bridge';

// Android TV 宿主
export { createAndroidTvApp } from './platform/android-tv';
export type { AndroidTvApp } from './platform/android-tv';

/**
 * 开发/本地演示用装配：以内存存储 + 内存 NAS 启动，无需真实设备。
 * 真实 TV 端应传入 FetchHttpClient 与 IndexedDB/文件缓存实现。
 */
export function createDevApp(endpoint: DavEndpoint): AppContext {
  const deps: PlatformDeps = {
    endpoint,
    http: new FetchHttpClient({ username: endpoint.username, password: endpoint.password }),
    cache: new MemoryContentCache(),
    catalog: new MemoryCatalogStore(),
  };
  return composeRoot(deps);
}
