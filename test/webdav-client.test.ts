import { describe, it, expect } from 'vitest';
import { createWebdavClient } from '../src/webdav/adapters';
import { DavError } from '../src/webdav/types';
import { MemoryHttpClient } from '../src/storage/memory';
import type { DavEndpoint, HttpClient } from '../src/webdav/types';

/** 直接回吐给定 PROPFIND XML 的 HttpClient（用于验证解析层对真实 NAS 响应的兼容性） */
class RawXmlHttpClient implements HttpClient {
  constructor(private readonly xml: string) {}
  async request(
    _url: string,
    _init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<{ status: number; headers: Record<string, string>; text: string; arrayBuffer: ArrayBuffer }> {
    return {
      status: 207,
      headers: { server: 'test-nas/1.0' },
      text: this.xml,
      arrayBuffer: new TextEncoder().encode(this.xml).buffer,
    };
  }
}

function bufOf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer;
}

/**
 * 群晖 DSM 等服务器：PROPFIND 响应里的 href 是完整 URL（含 scheme://host:port），
 * 而非相对路径。此前未覆盖该场景，导致 url() 把完整 URL 当相对路径拼成畸形地址、GET 404。
 */
class SynologyHttpClient implements HttpClient {
  private readonly files = new Map<
    string,
    { buf: string; etag: string; ct: string; isDir?: boolean }
  >([
    ['http://nas.local/Photos', { isDir: true, buf: '', etag: 'd', ct: 'httpd/unix-directory' }],
    ['http://nas.local/Photos/a.jpg', { buf: 'IMG1', etag: 'e1', ct: 'image/jpeg' }],
    ['http://nas.local/Photos/Sub', { isDir: true, buf: '', etag: 'd2', ct: 'httpd/unix-directory' }],
  ]);
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
      const f = this.files.get(_url);
      if (!f || f.isDir)
        return { status: 404, headers: {}, text: 'not found', arrayBuffer: new ArrayBuffer(0) };
      const bytes = bufOf(f.buf);
      return { status: 200, headers: { 'content-type': f.ct }, text: f.buf, arrayBuffer: bytes };
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

const tree = new Map<string, { isDir?: boolean; buf: ArrayBuffer; etag: string; lm: number; ct: string }>([
  ['/photos', { isDir: true, buf: new ArrayBuffer(0), etag: 'd', lm: 1, ct: 'httpd/unix-directory' }],
  ['/photos/a.jpg', { buf: bufOf('AAA'), etag: 'v2', lm: 1000, ct: 'image/jpeg' }],
]);

describe('WebdavClient', () => {
  it('list 返回子项且不返回目录自身', async () => {
    const dav = createWebdavClient(endpoint, new MemoryHttpClient(tree), { concurrency: 4 });
    const items = await dav.list('/photos', { depth: 1 });
    expect(items).toHaveLength(1);
    expect(items[0].name).toBe('a.jpg');
    expect(items[0].etag).toBe('v2');
  });

  it('get 返回文件二进制', async () => {
    const dav = createWebdavClient(endpoint, new MemoryHttpClient(tree), { concurrency: 4 });
    const buf = await dav.get('/photos/a.jpg');
    expect(new TextDecoder().decode(buf)).toBe('AAA');
  });

  it('stat 返回目标资源', async () => {
    const dav = createWebdavClient(endpoint, new MemoryHttpClient(tree), { concurrency: 4 });
    const r = await dav.stat('/photos/a.jpg');
    expect(r.contentType).toBe('image/jpeg');
  });

  it('缺失资源抛出 DavError(NOT_FOUND)', async () => {
    const dav = createWebdavClient(endpoint, new MemoryHttpClient(tree), { concurrency: 4 });
    await expect(dav.get('/photos/missing.jpg')).rejects.toBeInstanceOf(DavError);
  });

  it('probe 报告可达', async () => {
    const dav = createWebdavClient(endpoint, new MemoryHttpClient(tree), { concurrency: 4 });
    const r = await dav.probe();
    expect(r.ok).toBe(true);
  });

  it('解析带尾斜杠与命名空间前缀的真实 NAS 响应', async () => {
    // 群晖 DSM 等服务器：href 以 / 结尾、<D:collection/> 带命名空间前缀
    const xml = `<?xml version="1.0"?>
<multistatus xmlns:D="DAV:">
  <response><D:href>/Photos/</D:href><propstat><prop>
    <D:resourcetype><D:collection/></D:resourcetype>
    <D:getetag>"e1"</D:getetag>
  </prop></propstat></response>
  <response><D:href>/Vacation/</D:href><propstat><prop>
    <D:resourcetype><D:collection/></D:resourcetype>
    <D:getetag>"e2"</D:getetag>
  </prop></propstat></response>
  <response><D:href>/a.jpg</D:href><propstat><prop>
    <D:resourcetype/>
    <D:getcontenttype>image/jpeg</D:getcontenttype>
  </prop></propstat></response>
</multistatus>`;
    const dav = createWebdavClient(endpoint, new RawXmlHttpClient(xml), { concurrency: 4 });
    const items = await dav.list('/', { depth: 1 });
    const byName = Object.fromEntries(items.map((r) => [r.name, r]));
    // 关键回归：尾斜杠 href 不能让 name 变成空串
    expect(byName['Photos']?.isCollection).toBe(true);
    expect(byName['Vacation']?.isCollection).toBe(true);
    expect(byName['a.jpg']?.isCollection).toBe(false);
    expect(items.map((r) => r.name).sort()).toEqual(['Photos', 'Vacation', 'a.jpg']);
  });

  it('getcontenttype=httpd/unix-directory 也识别为集合', async () => {
    const xml = `<?xml version="1.0"?>
<multistatus xmlns="DAV:">
  <response><href>/Music/</href><propstat><prop>
    <resourcetype/>
    <getcontenttype>httpd/unix-directory</getcontenttype>
  </prop></propstat></response>
</multistatus>`;
    const dav = createWebdavClient(endpoint, new RawXmlHttpClient(xml), { concurrency: 4 });
    const items = await dav.list('/', { depth: 1 });
    expect(items[0].name).toBe('Music');
    expect(items[0].isCollection).toBe(true);
  });

  it('整段响应带 D: 命名空间前缀也能解析（群晖 DSM 真实形态）', async () => {
    // 关键回归：最外层 <D:response> 此前因正则写死 <response> 而整体匹配为空，导致列不出任何子文件夹
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response>
<D:href>/photo/</D:href>
<D:propstat><D:prop>
<D:resourcetype><D:collection/></D:resourcetype>
<D:getetag>"abc"</D:getetag>
<D:getcontentlength>0</D:getcontentlength>
</D:prop></D:propstat>
</D:response>
<D:response>
<D:href>/Movies/</D:href>
<D:propstat><D:prop>
<D:resourcetype><D:collection/></D:resourcetype>
</D:prop></D:propstat>
</D:response>
<D:response>
<D:href>/cover.jpg</D:href>
<D:propstat><D:prop>
<D:resourcetype/>
<D:getcontenttype>image/jpeg</D:getcontenttype>
</D:prop></D:propstat>
</D:response>
</D:multistatus>`;
    const dav = createWebdavClient(endpoint, new RawXmlHttpClient(xml), { concurrency: 4 });
    const items = await dav.list('/', { depth: 1 });
    const byName = Object.fromEntries(items.map((r) => [r.name, r]));
    expect(items).toHaveLength(3);
    expect(byName['photo']?.isCollection).toBe(true);
    expect(byName['Movies']?.isCollection).toBe(true);
    expect(byName['cover.jpg']?.isCollection).toBe(false);
  });

  it('群晖完整 URL href：list 解析正确且 get 不被拼成畸形地址（404 回归）', async () => {
    const dav = createWebdavClient(endpoint, new SynologyHttpClient(), { concurrency: 4 });
    const items = await dav.list('/Photos', { depth: 1 });
    const byName = Object.fromEntries(items.map((r) => [r.name, r]));
    expect(byName['a.jpg']?.isCollection).toBe(false);
    expect(byName['Sub']?.isCollection).toBe(true);
    // 关键回归：get 传入完整 URL href，url() 应直接复用，GET 命中而非 404
    const buf = await dav.get('http://nas.local/Photos/a.jpg');
    expect(new TextDecoder().decode(buf)).toBe('IMG1');
  });

  it('listAll 在服务器拒绝 Depth:infinity 时回退为 Depth:1 递归', async () => {
    // 部分服务器（群晖默认配置、部分网关）禁用 infinity，返回 403/400；此时应逐层递归而不是失败
    let sawInfinity = false;
    const http: HttpClient = {
      async request(
        url: string,
        init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
      ) {
        const path = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, '') || '/';
        if (init.method === 'PROPFIND') {
          if (init.headers?.['Depth'] === 'infinity') {
            sawInfinity = true;
            return { status: 403, headers: {}, text: 'forbidden', arrayBuffer: new ArrayBuffer(0) };
          }
          const body =
            path === '/'
              ? `<response><href>/sub/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>` +
                `<response><href>/a.jpg</href><propstat><prop><resourcetype/><getcontenttype>image/jpeg</getcontenttype></prop></propstat></response>`
              : path === '/sub'
                ? `<response><href>/sub/b.jpg</href><propstat><prop><resourcetype/><getcontenttype>image/jpeg</getcontenttype></prop></propstat></response>`
                : '';
          const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:">${body}</multistatus>`;
          return { status: 207, headers: {}, text: xml, arrayBuffer: bufOf(xml) };
        }
        return { status: 405, headers: {}, text: '', arrayBuffer: new ArrayBuffer(0) };
      },
    };
    const dav = createWebdavClient(endpoint, http, { concurrency: 4 });
    const all = await dav.listAll('/');
    expect(sawInfinity).toBe(true);
    expect(all.map((r) => r.name).sort()).toEqual(['a.jpg', 'b.jpg', 'sub']);
    expect(all.find((r) => r.name === 'sub')?.isCollection).toBe(true);
  });

  it('OpenList/Alist：href 带 /dav 前缀时自动剥离，GET 不再拼出双前缀（404 回归）', async () => {
    // OpenList 的 PROPFIND 响应里 href 以 /dav/ 开头；若服务器地址也含 /dav，
    // 直接拼接会得到 /dav/dav/... → 浏览正常但下载 404。此处验证归一化后一切正确。
    const seen: string[] = [];
    const http: HttpClient = {
      async request(
        url: string,
        init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
      ) {
        seen.push(`${init.method} ${url}`);
        if (init.method === 'PROPFIND') {
          const xml = `<?xml version="1.0"?><multistatus xmlns="DAV:">
<response><href>/dav/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
<response><href>/dav/Photos/</href><propstat><prop><resourcetype><collection/></resourcetype></prop></propstat></response>
<response><href>/dav/Photos/a.jpg</href><propstat><prop><resourcetype/><getcontenttype>image/jpeg</getcontenttype><getetag>"e1"</getetag></prop></propstat></response>
</multistatus>`;
          return { status: 207, headers: {}, text: xml, arrayBuffer: bufOf(xml) };
        }
        if (init.method === 'GET' && url.endsWith('/dav/Photos/a.jpg')) {
          return { status: 200, headers: {}, text: 'OKIMG', arrayBuffer: bufOf('OKIMG') };
        }
        return { status: 404, headers: {}, text: 'not found', arrayBuffer: new ArrayBuffer(0) };
      },
    };
    const alistEndpoint: DavEndpoint = { ...endpoint, server: 'http://nas.local:5244/dav' };
    const dav = createWebdavClient(alistEndpoint, http, { concurrency: 4 });
    const items = await dav.list('/');
    // href 已剥离 /dav 前缀，目录自身（/dav → /）被正确过滤
    expect(items.map((r) => r.href).sort()).toEqual(['/Photos', '/Photos/a.jpg']);
    // GET 用相对 href 重新拼接 → 只带一个 /dav 前缀
    const buf = await dav.get('/Photos/a.jpg');
    expect(new TextDecoder().decode(buf)).toBe('OKIMG');
    expect(seen.some((s) => s.includes('/dav/dav/'))).toBe(false);
  });
});
