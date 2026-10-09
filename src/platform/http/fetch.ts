// platform/http/fetch.ts —— 真实运行环境（TV / Node）的 HttpClient 实现
// 对应设计文档 §12 平台桥接

import type { HttpClient, HttpResponse } from '../../webdav/types';

/** 基于全局 fetch 的 HttpClient；Basic 认证由端点凭据注入 */
export class FetchHttpClient implements HttpClient {
  constructor(private readonly auth?: { username: string; password: string }) {}

  async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<HttpResponse> {
    const headers = new Headers(init.headers ?? {});
    if (this.auth) {
      headers.set('Authorization', 'Basic ' + btoa(`${this.auth.username}:${this.auth.password}`));
    }
    const res = await fetch(url, { method: init.method, headers, body: init.body, signal: init.signal });
    const buf = await res.arrayBuffer();
    const text = new TextDecoder().decode(buf);
    const h: Record<string, string> = {};
    res.headers.forEach((v, k) => (h[k] = v));
    return { status: res.status, headers: h, text, arrayBuffer: buf };
  }
}
