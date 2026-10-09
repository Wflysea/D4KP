// app/compose-root.ts —— 依赖注入组合根
// 对应设计文档 §8

import { Semaphore } from '../webdav/client';
import { WebdavClient } from '../webdav/client';
import { SyncEngine } from '../core/sync/sync-engine';
import type { IContentCache, ICatalogStore } from '../core/sync/types';
import type { DavEndpoint, HttpClient, IWebdavClient } from '../webdav/types';
import type { PlatformHost } from '../platform/types';

export interface PlatformDeps {
  endpoint: DavEndpoint;
  http: HttpClient; // 注入真实 FetchHttpClient 或测试桩
  cache: IContentCache;
  catalog: ICatalogStore;
  concurrency?: number;
  host?: PlatformHost; // 平台宿主能力（屏幕常亮 / 遥控 / 设备信息）
}

export interface AppContext {
  dav: IWebdavClient;
  sync: SyncEngine;
  host?: PlatformHost;
}

/** 组合根：将平台能力装配为应用上下文（核心层保持纯逻辑、可单测） */
export function composeRoot(deps: PlatformDeps): AppContext {
  const dav = new WebdavClient(deps.endpoint, deps.http, new Semaphore(deps.concurrency ?? 4));
  const sync = new SyncEngine(dav, deps.cache, deps.catalog);
  return { dav, sync, host: deps.host };
}
