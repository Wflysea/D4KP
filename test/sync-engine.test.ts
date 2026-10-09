import { describe, it, expect } from 'vitest';
import { SyncEngine } from '../src/core/sync/sync-engine';
import { createWebdavClient } from '../src/webdav/adapters';
import type { DavEndpoint, HttpClient } from '../src/webdav/types';
import { MemoryHttpClient, MemoryContentCache, MemoryCatalogStore } from '../src/storage/memory';
import type { Playlist } from '../src/types/domain';

function bufOf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

/** 群晖风格 HttpClient：PROPFIND 响应里的 href 为完整 URL。 */
class SynologyHttpClient implements HttpClient {
  async request(
    _url: string,
    init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer }> {
    if (init.method === 'PROPFIND') {
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response><href>http://nas.local/Photos/</href><propstat><prop>
    <resourcetype><collection/></resourcetype>
    <getetag>"d"</getetag>
  </prop></propstat></response>
  <response><href>http://nas.local/Photos/a.jpg</href><propstat><prop>
    <resourcetype/>
    <getcontenttype>image/jpeg</getcontenttype>
    <getetag>"e1"</getetag>
  </prop></propstat></response>
  <response><href>http://nas.local/Photos/Sub/</href><propstat><prop>
    <resourcetype><collection/></resourcetype>
    <getetag>"d2"</getetag>
  </prop></propstat></response>
</multistatus>`;
      return { status: 207, headers: { server: 'Synology/1.0' }, text: xml, arrayBuffer: bufOf(xml) };
    }
    if (init.method === 'GET') {
      // href 归一化后 GET 统一走 server（https）拼接，此处按路径匹配、与 scheme 无关
      if (_url.endsWith('/Photos/a.jpg')) {
        return { status: 200, headers: {}, text: 'IMG1', arrayBuffer: bufOf('IMG1') };
      }
      return { status: 404, headers: {}, text: 'not found', arrayBuffer: new ArrayBuffer(0) };
    }
    return { status: 404, headers: {}, text: 'unsupported', arrayBuffer: new ArrayBuffer(0) };
  }
}

const endpoint: DavEndpoint = {
  server: 'https://nas.local',
  rootPath: '/photos',
  username: 'u',
  password: 'p',
  https: true,
  verifySsl: false,
};

function buildTree() {
  return new Map<string, { isDir?: boolean; buf: ArrayBuffer; etag: string; lm: number; ct: string }>([
    ['/photos/a.jpg', { buf: bufOf('AAA'), etag: 'v2', lm: 1000, ct: 'image/jpeg' }],
    ['/photos/b.jpg', { buf: bufOf('BBB'), etag: 'v1', lm: 1000, ct: 'image/jpeg' }],
    ['/photos/sub', { isDir: true, buf: new ArrayBuffer(0), etag: 'd1', lm: 1000, ct: 'httpd/unix-directory' }],
    ['/photos/sub/c.jpg', { buf: bufOf('CCC'), etag: 'v1', lm: 1000, ct: 'image/jpeg' }],
  ]);
}

const playlist: Playlist = {
  id: 'pl1',
  name: '测试',
  source: { type: 'directory', accountId: 'acc', root: '/photos' },
  order: 'sequential',
  transition: 'fade',
  dwellSec: 10,
};

describe('SyncEngine', () => {
  it('仅下载 etag/修改时间变更或新增的项', async () => {
    const http = new MemoryHttpClient(buildTree());
    const cache = new MemoryContentCache();
    const catalog = new MemoryCatalogStore();
    // 预置 b.jpg 本地缓存（etag 一致）→ 应被跳过
    await catalog.upsert({
      id: 'old',
      accountId: 'acc',
      path: '/photos/b.jpg',
      kind: 'image',
      etag: 'v1',
      lastModified: 1000,
      tags: [],
      favorite: false,
    });
    const dav = createWebdavClient(endpoint, http, { concurrency: 4 });
    const engine = new SyncEngine(dav, cache, catalog);
    const report = await engine.syncPlaylist(playlist);
    expect(report.scanned).toBe(3); // 仅统计文件：a.jpg / b.jpg / sub/c.jpg（目录不入扫描数）
    expect(report.downloaded).toBe(2); // a.jpg 变更 + sub/c.jpg 新增，b.jpg 跳过
    expect(cache.size()).toBeGreaterThan(0);
  });

  it('重复同步不重复下载（幂等）', async () => {
    const http = new MemoryHttpClient(buildTree());
    const cache = new MemoryContentCache();
    const catalog = new MemoryCatalogStore();
    const dav = createWebdavClient(endpoint, http, { concurrency: 4 });
    const engine = new SyncEngine(dav, cache, catalog);
    await engine.syncPlaylist(playlist);
    const second = await engine.syncPlaylist(playlist);
    expect(second.downloaded).toBe(0);
  });

  it('群晖完整 URL href：syncPlaylist 不抛 404 且正确下载', async () => {
    const http = new SynologyHttpClient();
    const cache = new MemoryContentCache();
    const catalog = new MemoryCatalogStore();
    const dav = createWebdavClient(endpoint, http, { concurrency: 4 });
    const engine = new SyncEngine(dav, cache, catalog);
    const pl: Playlist = {
      ...playlist,
      source: { type: 'directory', accountId: 'acc', root: '/Photos' },
    };
    const report = await engine.syncPlaylist(pl);
    expect(report.scanned).toBe(1); // 仅统计文件（a.jpg）；Sub 是目录不入扫描数
    expect(report.downloaded).toBe(1); // a.jpg 下载成功，未因畸形 URL 抛 404
  });

  it('单个文件下载失败只跳过，不中断整次同步；@eaDir 与隐藏文件被预先过滤', async () => {
    // NAS 场景：目录里有 1 个好图、1 个坏链接、群晖缩略图目录 @eaDir、macOS 的 .DS_Store。
    // 此前任何一个 404 都会让整个同步失败并显示「连接失败：资源不存在（404）」。
    class FaultyNasHttpClient implements HttpClient {
      async request(
        _url: string,
        init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
      ): Promise<{ status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer }> {
        if (init.method === 'PROPFIND') {
          const xml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response><href>/photos/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
  <response><href>/photos/a.jpg</href><propstat><prop><resourcetype/><getcontenttype>image/jpeg</getcontenttype><getetag>"e1"</getetag></prop></propstat></response>
  <response><href>/photos/bad.jpg</href><propstat><prop><resourcetype/><getcontenttype>image/jpeg</getcontenttype><getetag>"e2"</getetag></prop></propstat></response>
  <response><href>/photos/@eaDir/a.jpg</href><propstat><prop><resourcetype/><getcontenttype>image/jpeg</getcontenttype><getetag>"e3"</getetag></prop></propstat></response>
  <response><href>/photos/.DS_Store</href><propstat><prop><resourcetype/><getcontenttype>application/octet-stream</getcontenttype><getetag>"e4"</getetag></prop></propstat></response>
</multistatus>`;
          return { status: 207, headers: {}, text: xml, arrayBuffer: bufOf(xml) };
        }
        if (init.method === 'GET') {
          if (_url.endsWith('/photos/a.jpg')) {
            return { status: 200, headers: {}, text: 'AAA', arrayBuffer: bufOf('AAA') };
          }
          return { status: 404, headers: {}, text: 'not found', arrayBuffer: new ArrayBuffer(0) };
        }
        return { status: 405, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) };
      }
    }
    const dav = createWebdavClient(endpoint, new FaultyNasHttpClient(), { concurrency: 4 });
    const engine = new SyncEngine(dav, new MemoryContentCache(), new MemoryCatalogStore());
    const pl: Playlist = {
      ...playlist,
      source: { type: 'directory', accountId: 'acc', root: '/photos' },
    };
    const report = await engine.syncPlaylist(pl);
    expect(report.scanned).toBe(2); // 仅 a.jpg 与 bad.jpg；@eaDir 与 .DS_Store 已被过滤
    expect(report.downloaded).toBe(1); // a.jpg 成功
    expect(report.skipped).toBe(1); // 仅 bad.jpg 失败跳过，整体不抛 404
  });
});
