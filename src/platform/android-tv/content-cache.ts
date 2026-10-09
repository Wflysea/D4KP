// platform/android-tv/content-cache.ts —— 内容寻址缓存（App 私有目录）
// 对应设计文档 §6 / §9：壁纸二进制经原生 blob 存储落盘，无桥时回退内存。

import type { IContentCache, ContentCacheMeta } from '../../core/sync/types';
import type { WallpaperItem } from '../../types/domain';
import { sha256Hex } from '../../webdav/cert';
import { getNativeBridge, type NativeBridge } from './bridge';
import { bytesToBase64, base64ToBytes } from '../types';

export class AndroidTvContentCache implements IContentCache {
  private mem = new Map<string, ArrayBuffer>();
  private bytes = 0;

  constructor(private readonly bridge: NativeBridge | null = getNativeBridge()) {}

  private async key(meta: ContentCacheMeta): Promise<string> {
    return sha256Hex(
      new TextEncoder().encode(`${meta.accountId}|${meta.path}|${meta.etag ?? ''}`).buffer,
    );
  }

  async put(buf: ArrayBuffer, meta: ContentCacheMeta): Promise<string> {
    const key = await this.key(meta);
    if (this.bridge) {
      this.bridge.saveBlob(key, bytesToBase64(buf));
    } else {
      const copy = buf.slice(0);
      if (!this.mem.has(key)) this.bytes += copy.byteLength;
      this.mem.set(key, copy);
    }
    return key;
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    if (this.bridge) {
      const b64 = this.bridge.loadBlob(key);
      return b64 ? base64ToBytes(b64) : null;
    }
    return this.mem.get(key) ?? null;
  }

  size(): number {
    if (this.bridge) return this.bridge.blobSize();
    return this.bytes;
  }

  async evictTo(quotaBytes: number): Promise<void> {
    if (!this.bridge) {
      if (this.bytes > quotaBytes) {
        this.mem.clear();
        this.bytes = 0;
      }
      return;
    }
    this.bridge.evictBlobs(quotaBytes);
  }

  /** 根据壁纸条目取出本地缓存内容，生成可在 <img> 中显示的 Blob URL（按 magic byte 嗅探 mime） */
  async getObjectUrl(item: WallpaperItem): Promise<string | null> {
    return this.objectUrlForKey(item.localCacheKey ?? item.id);
  }

  /** 按缓存键生成 Blob URL（懒加载播放：先 put/get 再取 URL） */
  async objectUrlForKey(key: string): Promise<string | null> {
    const buf = await this.get(key);
    if (!buf) return null;
    return URL.createObjectURL(new Blob([buf], { type: sniffMime(buf) }));
  }
}

export function sniffMime(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf.slice(0, 12));
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  return 'application/octet-stream';
}
