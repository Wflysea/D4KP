// webdav/adapters.ts —— 厂商适配与工厂
// 对应设计文档 §5.3

import { Semaphore, WebdavClient } from './client';
import type { DavEndpoint, HttpClient, IWebdavClient } from './types';

export type NasVendor = 'synology' | 'qnap' | 'truenas' | 'generic';

/** 依据 probe 返回的 Server 头识别厂商（默认 generic） */
export function recognizeVendor(serverHeader: string | undefined): NasVendor {
  const s = (serverHeader ?? '').toLowerCase();
  if (s.includes('synology') || s.includes('nginx')) return 'synology';
  if (s.includes('qnap')) return 'qnap';
  if (s.includes('truenas') || s.includes('freebsd')) return 'truenas';
  return 'generic';
}

export interface AdapterOptions {
  concurrency?: number;
}

/** 组合根使用：构造一个可注入 HttpClient 的 WebDAV 客户端 */
export function createWebdavClient(
  endpoint: DavEndpoint,
  http: HttpClient,
  opts: AdapterOptions = {},
): IWebdavClient {
  return new WebdavClient(endpoint, http, new Semaphore(opts.concurrency ?? 4));
}
