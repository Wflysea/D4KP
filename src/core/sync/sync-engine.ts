// core/sync/sync-engine.ts —— 增量同步引擎
// 对应设计文档 §6

import type { Playlist, WallpaperItem } from '../../types/domain';
import type { IWebdavClient } from '../../webdav/types';
import type { IContentCache, ICatalogStore } from './types';

export interface SyncReport {
  scanned: number;
  downloaded: number;
  cacheBytes: number;
  /** 因下载失败（404/403 等）被跳过的条目数；单个失败不中断整体同步 */
  skipped: number;
}

/** 同步进度回调：done 为已处理条目数，total 为本次需处理的文件总数 */
export type SyncProgress = (done: number, total: number) => void;

/**
 * NAS 系统目录/隐藏文件：群晖缩略图元数据目录 @eaDir（WebDAV GET 几乎必 404）、
 * 群晖/威联通回收站与快照目录、各类 "." 开头的隐藏文件（.DS_Store、._* 等）。
 * 这些条目 PROPFIND 会列出来，但下载必然失败，直接在同步前过滤。
 */
export function isSystemPath(href: string): boolean {
  let path = href;
  if (/^https?:\/\//i.test(href)) {
    try {
      path = new URL(href).pathname;
    } catch {
      /* 保持原样 */
    }
  }
  return path.split('/').some(
    (seg) => seg.startsWith('.') || seg === '@eaDir' || seg === '#recycle' || seg === '#snapshot',
  );
}

function guessKind(ct?: string, name = ''): WallpaperItem['kind'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext) || ct?.startsWith('video')) return 'video';
  if (ext === 'webp' || ct?.includes('webp')) return 'webp';
  if (['heic', 'heif'].includes(ext)) return 'livephoto';
  return 'image';
}

export class SyncEngine {
  constructor(
    private readonly dav: IWebdavClient,
    private readonly cache: IContentCache,
    private readonly catalog: ICatalogStore,
  ) {}

  async syncPlaylist(pl: Playlist, onProgress?: SyncProgress): Promise<SyncReport> {
    const sources = this.catalog.resolveSources(pl.source);
    let scanned = 0;
    let downloaded = 0;
    let skipped = 0;
    for (const s of sources) {
      // listAll 内部优先 Depth: infinity，失败自动回退逐层递归；再剔除系统/隐藏条目
      const remote = (await this.dav.listAll(s.root)).filter(
        (r) => !r.isCollection && !isSystemPath(r.href),
      );
      scanned += remote.length;
      const total = remote.length;
      let done = 0;
      for (const r of remote) {
        try {
          const local = this.catalog.getCached(r.href, s.accountId);
          if (local && local.etag === r.etag && local.lastModified === r.lastModified) continue;
          const buf = await this.dav.get(r.href);
          const key = await this.cache.put(buf, {
            accountId: s.accountId,
            path: r.href,
            etag: r.etag,
            lastModified: r.lastModified,
          });
          const item: WallpaperItem = {
            id: key,
            accountId: s.accountId,
            path: r.href,
            kind: guessKind(r.contentType, r.name),
            etag: r.etag,
            lastModified: r.lastModified,
            localCacheKey: key,
            tags: [],
            favorite: false,
          };
          await this.catalog.upsert(item);
          downloaded++;
        } catch {
          // 单个资源下载失败（如 @eaDir 缩略图、被并发移动/删除的文件）只跳过，不让整次同步失败
          skipped++;
        } finally {
          done++;
          onProgress?.(done, total);
        }
      }
    }
    return { scanned, downloaded, cacheBytes: this.cache.size(), skipped };
  }
}
