// core/sync/types.ts —— 同步引擎依赖的存储契约
// 对应设计文档 §6 / §9

import type { WallpaperItem, Playlist } from '../../types/domain';

export interface ContentCacheMeta {
  accountId: string;
  path: string;
  etag?: string;
  lastModified?: number;
}

export interface IContentCache {
  put(buf: ArrayBuffer, meta: ContentCacheMeta): Promise<string>;
  get(key: string): Promise<ArrayBuffer | null>;
  size(): number;
  evictTo(quotaBytes: number): Promise<void>;
}

export interface ICatalogStore {
  upsert(item: WallpaperItem): Promise<void>;
  getCached(path: string, accountId: string): WallpaperItem | undefined;
  resolveSources(source: Playlist['source']): { root: string; accountId: string }[];
  listBySource(source: Playlist['source']): WallpaperItem[];
}
