// storage/memory.ts —— 内存实现：开发与单元测试使用
// 真实 TV 端应替换为 IndexedDB / 文件缓存实现（设计文档 §9）

import { sha256Hex } from '../webdav/cert';
import type { WallpaperItem, Playlist } from '../types/domain';
import type { IContentCache, ICatalogStore, ContentCacheMeta } from '../core/sync/types';
import type { DavResource } from '../types/domain';

/** 模拟一台 NAS 的内存 HttpClient（支持 PROPFIND / GET） */
export class MemoryHttpClient {
  constructor(
    private readonly tree: Map<
      string,
      { isDir?: boolean; buf: ArrayBuffer; etag: string; lm: number; ct: string }
    >,
  ) {}

  async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer }> {
    const path = decodeURIComponent(new URL(url).pathname);
    if (init.method === 'PROPFIND') {
      const depth = (init.headers?.['Depth'] ?? '1') as string;
      const entries = [...this.tree.entries()].filter(([p]) => {
        if (depth === '0') return p === path;
        if (depth === '1') return p !== path && p.startsWith(path) && !p.slice(path.length + 1).includes('/');
        return p.startsWith(path);
      });
      const body =
        `<?xml version="1.0"?><multistatus xmlns="DAV:">` +
        entries
          .map(([p, f]) => {
            const resType = f.isDir ? '<resourcetype><collection/></resourcetype>' : '<resourcetype/>';
            return `<response><href>${encodeURI(p)}</href><propstat><prop>${resType}` +
              `<getetag>"${f.etag}"</getetag>` +
              `<getlastmodified>${new Date(f.lm).toUTCString()}</getlastmodified>` +
              `<getcontentlength>${f.buf.byteLength}</getcontentlength>` +
              `<getcontenttype>${f.ct}</getcontenttype>` +
              `</prop></propstat></response>`;
          })
          .join('') +
        `</multistatus>`;
      return { status: 207, headers: { server: 'memory-nas/1.0' }, text: body, arrayBuffer: new TextEncoder().encode(body).buffer };
    }
    if (init.method === 'GET') {
      const f = this.tree.get(path);
      if (!f) return { status: 404, headers: {}, text: 'not found', arrayBuffer: new ArrayBuffer(0) };
      return { status: 200, headers: { 'Content-Type': f.ct }, text: '', arrayBuffer: f.buf.slice(0) };
    }
    return { status: 405, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) };
  }
}

/** 内容寻址缓存（内存版） */
export class MemoryContentCache implements IContentCache {
  private store = new Map<string, ArrayBuffer>();
  private bytes = 0;

  async put(buf: ArrayBuffer, meta: ContentCacheMeta): Promise<string> {
    const key = await sha256Hex(
      new TextEncoder().encode(`${meta.accountId}|${meta.path}|${meta.etag ?? ''}`).buffer,
    );
    const copy = buf.slice(0);
    if (!this.store.has(key)) this.bytes += copy.byteLength;
    this.store.set(key, copy);
    return key;
  }
  async get(key: string): Promise<ArrayBuffer | null> {
    return this.store.get(key) ?? null;
  }
  size(): number {
    return this.bytes;
  }
  async evictTo(): Promise<void> {
    /* scaffold: 不实现 LRU 淘汰 */
  }
}

/** 壁纸目录索引（内存版） */
export class MemoryCatalogStore implements ICatalogStore {
  private byPath = new Map<string, WallpaperItem>();
  private all: WallpaperItem[] = [];

  async upsert(item: WallpaperItem): Promise<void> {
    this.byPath.set(item.path, item);
    this.all.push(item);
  }
  getCached(path: string, accountId: string): WallpaperItem | undefined {
    const it = this.byPath.get(path);
    return it && it.accountId === accountId ? it : undefined;
  }
  resolveSources(source: Playlist['source']): { root: string; accountId: string }[] {
    if (source.type === 'directory') return [{ root: source.root, accountId: source.accountId }];
    return [{ root: '/', accountId: source.accountId }];
  }
  listBySource(source: Playlist['source']): WallpaperItem[] {
    return this.all.filter((i) => i.accountId === source.accountId);
  }
}

/** 测试辅助：构造一条 DavResource */
export function makeResource(p: string, f: { buf: ArrayBuffer; etag: string; lm: number; ct: string }): DavResource {
  return {
    href: p,
    name: p.split('/').pop() ?? p,
    isCollection: false,
    etag: f.etag,
    lastModified: f.lm,
    contentLength: f.buf.byteLength,
    contentType: f.ct,
  };
}
