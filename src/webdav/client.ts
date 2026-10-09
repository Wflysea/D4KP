// webdav/client.ts —— 基于 fetch 的 RFC 4918 实现
// 对应设计文档 §5.1 / §5.2

import type { DavResource } from '../types/domain';
import {
  DavError,
  type DavEndpoint,
  type DavProbeResult,
  type DavRequestOptions,
  type HttpClient,
  type IWebdavClient,
} from './types';

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<propfind xmlns="DAV:"><prop>
  <resourcetype/><getetag/><getlastmodified/>
  <getcontentlength/><getcontenttype/>
</prop></propfind>`;

/** 并发限流器，保护 NAS 与电视负载（设计文档 §5.2） */
export class Semaphore {
  private queue: Array<() => void> = [];
  private active = 0;
  constructor(private readonly limit: number) {}
  acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++;
        resolve(() => this.release());
      });
    });
  }
  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** 从 PROPFIND XML 中按本地名（忽略命名空间前缀）提取属性值 */
function matchAttr(block: string, local: string): string | undefined {
  const re = new RegExp(`<[^>]*:?${local}[^>]*>([\\s\\S]*?)<\\/[^>]*:?${local}>`, 'i');
  const m = block.match(re);
  return m ? m[1].trim() : undefined;
}

/**
 * 从 href 取「该资源本身的名称」（最后一个非空路径段）。
 * 注意：WebDAV 集合（文件夹）的 href 通常以斜杠结尾（如 /Photos/），
 * 直接用 split('/').pop() 会得到空串，必须把尾斜杠去掉再取段。
 * href 既可能是裸路径也可能是完整 URL（含 scheme://host），这里都能正确取到末段。
 */
function lastNameOf(href: string): string {
  const trimmed = href.replace(/\/+$/, '');
  const seg = trimmed.split('/').pop() ?? '';
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

function parsePropfind(xml: string): DavResource[] {
  // 兼容命名空间前缀（如 <D:response> / <d:response>）；无前缀的 <response> 同样匹配
  const blocks = xml.match(/<[^>]*:?response[\s\S]*?<\/[^>]*:?response>/gi) ?? [];
  return blocks.map((block) => {
    const href = (block.match(/<[^>]*:?href>([\s\S]*?)<\/[^>]*:?href>/i) ?? [, ''])[1].trim();
    const etag = matchAttr(block, 'getetag')?.replace(/"/g, '');
    const lm = matchAttr(block, 'getlastmodified');
    const len = matchAttr(block, 'getcontentlength');
    const ct = matchAttr(block, 'getcontenttype');
    // 判定为集合：① resourcetype 含 <collection/>（兼容 D: 等命名空间前缀）；② 个别服务器用
    // getcontenttype=httpd/unix-directory 标记目录；③ RFC 4918 约定集合的 href 以斜杠结尾（绝大多数
    // 服务器如 OMV/TrueNAS/群晖均如此），作为兜底启发式，避免漏判导致「看不到文件夹」。
    const hrefForDir = href.trim().endsWith('/');
    const collection =
      /<[^>]*:?collection\s*\/?>/i.test(block) || ct === 'httpd/unix-directory' || hrefForDir;
    return {
      href,
      name: lastNameOf(href),
      isCollection: collection,
      etag,
      lastModified: lm ? Date.parse(lm) || undefined : undefined,
      contentLength: len ? Number(len) : undefined,
      contentType: ct,
    } satisfies DavResource;
  });
}

export class WebdavClient implements IWebdavClient {
  constructor(
    private readonly cfg: DavEndpoint,
    private readonly http: HttpClient,
    private readonly sem: Semaphore = new Semaphore(4),
  ) {}

  private url(p: string): string {
    // 群晖 DSM、部分 Nextcloud 等在 PROPFIND 响应里直接返回完整 URL（含 scheme://host:port）。
    // 若此处再拼 server 会变成 server + "http://host/..." 的畸形地址，GET 必 404。
    // 因此：已是完整 http(s) URL 就直接复用，不再拼接。
    if (/^https?:\/\//i.test(p)) return p;
    const base = this.cfg.server.replace(/\/$/, '');
    const path = p.startsWith('/') ? p : `/${p}`;
    return base + path;
  }

  /** host 无关的 href 归一化比较（PROPFIND 可能返回裸路径或完整 URL） */
  private samePath(href: string, url: string): boolean {
    const norm = (s: string): string => {
      const p = s.startsWith('http') ? new URL(s).pathname : s;
      return p.replace(/\/+$/, '');
    };
    return norm(href) === norm(url);
  }

  /** 把 href（裸路径或完整 URL）统一成相对服务器根的路径，供递归下钻时再次请求 */
  private toPath(href: string): string {
    if (/^https?:\/\//i.test(href)) {
      try {
        return new URL(href).pathname;
      } catch {
        /* 完整 URL 解析失败则按裸路径处理 */
      }
    }
    return href;
  }

  /**
   * href 归一化：剥离服务器地址里自带的路径前缀。
   * OpenList/Alist 的 WebDAV 响应里 href 以 /dav/ 开头（如 /dav/Photos/a.jpg）；若用户填写的
   * 服务器地址也带 /dav（http://host:5244/dav），直接拼接会得到 /dav/dav/... 双前缀 → GET 404。
   * 归一化后 href 统一为「相对 WebDAV 根」的路径，再由 url() 拼接回正确地址。
   */
  private normalizeHref(href: string): string {
    let path = this.toPath(href).replace(/\/+$/, '');
    let base = '';
    try {
      base = new URL(this.cfg.server).pathname.replace(/\/+$/, '');
    } catch {
      /* server 异常时按无前缀处理 */
    }
    if (base && (path === base || path.startsWith(base + '/'))) {
      path = path.slice(base.length) || '/';
    }
    return path === '' ? '/' : path;
  }

  /**
   * 全量枚举目录树。优先一次 Depth: infinity 请求（快）；部分服务器（群晖默认配置、
   * 某些网关）禁用或超时失败，此时回退为 Depth: 1 的 BFS 逐层递归，逐个跳过不可读目录。
   * maxDepth 限制递归层数，防止异常服务器把整个 NAS 树拖爆。
   */
  async listAll(dir: string, maxDepth = 5): Promise<DavResource[]> {
    try {
      const inf = await this.list(dir, { depth: 'infinity' });
      if (inf.length > 0) return inf;
    } catch {
      // infinity 被拒（403/400）或传输失败 → 走下方递归兜底
    }
    const out: DavResource[] = [];
    const seen = new Set<string>();
    const queue: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }];
    while (queue.length > 0) {
      const { path, depth } = queue.shift()!;
      let items: DavResource[];
      try {
        items = await this.list(path, { depth: 1 });
      } catch {
        continue; // 单个目录不可读不影响其余部分
      }
      for (const it of items) {
        const key = this.toPath(it.href).replace(/\/+$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(it);
        if (it.isCollection && depth + 1 < maxDepth) {
          queue.push({ path: this.toPath(it.href), depth: depth + 1 });
        }
      }
    }
    return out;
  }

  private toError(status: number): DavError {
    if (status === 401) return new DavError('AUTH', '认证失败（401）', status);
    if (status === 403) return new DavError('FORBIDDEN', '无访问权限（403）', status);
    if (status === 404) return new DavError('NOT_FOUND', '资源不存在（404）', status);
    return new DavError('NETWORK', `HTTP ${status}`, status);
  }

  async list(dir: string, opts: DavRequestOptions = {}): Promise<DavResource[]> {
    const release = await this.sem.acquire();
    try {
      const resp = await this.http.request(this.url(dir), {
        method: 'PROPFIND',
        headers: { Depth: String(opts.depth ?? 1), 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
        signal: opts.signal,
      });
      if (resp.status < 200 || resp.status >= 400) throw this.toError(resp.status);
      // href 归一化（剥离 OpenList/Alist 的 /dav 等服务器路径前缀）后再过滤目录自身
      const self = this.normalizeHref(this.url(dir));
      return parsePropfind(resp.text)
        .map((r) => ({ ...r, href: this.normalizeHref(r.href) }))
        .filter((r) => !this.samePath(r.href, self));
    } finally {
      release();
    }
  }

  async stat(path: string): Promise<DavResource> {
    const release = await this.sem.acquire();
    try {
      const resp = await this.http.request(this.url(path), {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      if (resp.status < 200 || resp.status >= 400) throw this.toError(resp.status);
      const items = parsePropfind(resp.text).map((r) => ({ ...r, href: this.normalizeHref(r.href) }));
      const hit = items.find((r) => this.samePath(r.href, this.normalizeHref(this.url(path))));
      if (!hit) throw new DavError('NOT_FOUND', 'stat 未返回目标资源', resp.status);
      return hit;
    } finally {
      release();
    }
  }

  async get(path: string, opts?: { range?: [number, number] }): Promise<ArrayBuffer> {
    const release = await this.sem.acquire();
    try {
      const headers: Record<string, string> = {};
      if (opts?.range) headers.Range = `bytes=${opts.range[0]}-${opts.range[1]}`;
      const resp = await this.http.request(this.url(path), { method: 'GET', headers });
      if (resp.status < 200 || resp.status >= 400) throw this.toError(resp.status);
      return resp.arrayBuffer;
    } finally {
      release();
    }
  }

  async probe(): Promise<DavProbeResult> {
    try {
      const resp = await this.http.request(this.url('/'), {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });
      if (resp.status === 401) return { ok: false, errorCode: 401, message: '认证失败' };
      if (resp.status >= 400) return { ok: false, errorCode: resp.status, message: resp.text.slice(0, 80) };
      return {
        ok: true,
        serverSoftware: resp.headers['server'],
        supportsInfiniteDepth: resp.status === 207,
      };
    } catch (e) {
      return { ok: false, errorCode: 0, message: String(e) };
    }
  }
}
