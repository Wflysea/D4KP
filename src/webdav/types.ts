// webdav/types.ts —— WebDAV 适配层契约
// 对应设计文档 §5

import type { DavResource } from '../types/domain';

/** NAS 连接端点配置 */
export interface DavEndpoint {
  server: string; // https://host:port
  rootPath: string;
  username: string;
  password: string;
  https: boolean;
  verifySsl: boolean;
  certFingerprint?: string; // 自签名证书 SHA-256 指纹（引脚锁定）
}

export interface DavRequestOptions {
  depth?: 0 | 1 | 'infinity';
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DavProbeResult {
  ok: boolean;
  serverSoftware?: string;
  supportsInfiniteDepth?: boolean;
  errorCode?: number;
  message?: string;
}

export type DavErrorCode = 'AUTH' | 'FORBIDDEN' | 'NOT_FOUND' | 'SSL' | 'TIMEOUT' | 'NETWORK';

export class DavError extends Error {
  constructor(
    public readonly code: DavErrorCode,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'DavError';
  }
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  text: string;
  arrayBuffer: ArrayBuffer;
}

/** 可注入的 HTTP 原语，便于在测试中替换为内存实现 */
export interface HttpClient {
  request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<HttpResponse>;
}

export interface IWebdavClient {
  list(dir: string, opts?: DavRequestOptions): Promise<DavResource[]>;
  /** 全量枚举目录树：优先 Depth: infinity，服务器拒绝或失败时回退为 Depth:1 逐层递归 */
  listAll(dir: string, maxDepth?: number): Promise<DavResource[]>;
  stat(path: string): Promise<DavResource>;
  get(path: string, opts?: { range?: [number, number] }): Promise<ArrayBuffer>;
  probe(): Promise<DavProbeResult>;
}
