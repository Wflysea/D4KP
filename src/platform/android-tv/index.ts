// platform/android-tv/index.ts —— Android TV App 聚合根
// 对应设计文档 §8：装配原生桥 + 平台能力 + 核心层，供 entry 引导使用。

import { composeRoot, type AppContext, type PlatformDeps } from '../../app/compose-root';
import { MemoryCatalogStore } from '../../storage/memory';
import { AndroidTvHost } from './host';
import { AndroidTvHttpClient } from './android-http';
import { AndroidTvCredentialVault } from './storage';
import { AndroidTvContentCache } from './content-cache';
import { getNativeBridge } from './bridge';
import type { DavEndpoint } from '../../webdav/types';
import type { StoredCredential } from '../types';

export interface AndroidTvApp {
  readonly host: AndroidTvHost;
  readonly vault: AndroidTvCredentialVault;
  readonly http: AndroidTvHttpClient;
  readonly cache: AndroidTvContentCache;
  readonly catalog: MemoryCatalogStore;
  /** 保存 NAS 端点（加密持久化），随后可调用 boot */
  setEndpoint(endpoint: DavEndpoint, dwellSec?: number, order?: 'sequential' | 'random'): Promise<void>;
  /** 读取已保存凭证并装配核心层上下文；无凭证则用默认端点（首启向导） */
  boot(): Promise<AppContext>;
}

const DEFAULT_ENDPOINT: DavEndpoint = {
  server: 'https://nas.local:5006',
  rootPath: '/wallpapers',
  username: '',
  password: '',
  https: true,
  verifySsl: true,
};

export function createAndroidTvApp(): AndroidTvApp {
  const bridge = getNativeBridge();
  const host = new AndroidTvHost(bridge);
  const vault = new AndroidTvCredentialVault(bridge);
  const cache = new AndroidTvContentCache(bridge);
  const catalog = new MemoryCatalogStore();

  async function resolveEndpoint(): Promise<DavEndpoint> {
    const saved = await vault.load();
    if (!saved) return { ...DEFAULT_ENDPOINT };
    return {
      server: saved.server,
      rootPath: saved.rootPath,
      username: saved.username,
      password: saved.password,
      https: saved.https,
      verifySsl: saved.verifySsl,
      certFingerprint: saved.certFingerprint,
    };
  }

  return {
    host,
    vault,
    http: new AndroidTvHttpClient(bridge),
    cache,
    catalog,
    async setEndpoint(endpoint: DavEndpoint, dwellSec?: number, order?: 'sequential' | 'random'): Promise<void> {
      const cred: StoredCredential = { accountId: 'primary', ...endpoint, dwellSec, order };
      await vault.save(cred);
    },
    async boot(): Promise<AppContext> {
      const endpoint = await resolveEndpoint();
      const deps: PlatformDeps = {
        endpoint,
        http: new AndroidTvHttpClient(bridge, { username: endpoint.username, password: endpoint.password }),
        cache,
        catalog,
        host,
        concurrency: 4,
      };
      return composeRoot(deps);
    },
  };
}
