// platform/android-tv/android-http.ts —— Android TV 的 WebDAV HTTP 实现
// 对应设计文档 §5 / §12：
//  - 原生桥存在时，请求经原生层发出（持有凭证、支持自签名证书引脚、绕过 WebView TLS 限制）
//  - 否则回退到标准 FetchHttpClient（浏览器/测试）

import type { HttpClient, HttpResponse } from '../../webdav/types';
import { FetchHttpClient } from '../http/fetch';
import { getNativeBridge, type NativeBridge } from './bridge';
import { base64ToBytes } from '../types';

interface NativeDavResponse {
  status: number;
  headers: Record<string, string>;
  base64: string;
  /** 原生层捕获的异常信息（status=0 表示传输层失败，如明文 HTTP 被系统拦截） */
  error?: string;
}

export class AndroidTvHttpClient implements HttpClient {
  private readonly fallback: FetchHttpClient | null;

  constructor(
    private readonly bridge: NativeBridge | null = getNativeBridge(),
    auth?: { username: string; password: string },
  ) {
    this.fallback = bridge ? null : new FetchHttpClient(auth);
  }

  async request(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<HttpResponse> {
    if (!this.bridge) {
      if (!this.fallback) throw new Error('AndroidTvHttpClient: 缺少原生桥且未提供回退凭据');
      return this.fallback.request(url, init);
    }
    const payload = this.bridge.davRequest(
      url,
      init.method,
      JSON.stringify(init.headers ?? {}),
      init.body ?? null,
    );
    const parsed = JSON.parse(payload) as NativeDavResponse;
    if (parsed.status === 0) {
      // 传输层失败（status=0）：原生侧已在 error 字段带回异常信息（如明文 HTTP 被拦截）。
      // 必须抛错而非返回空响应，否则上层会把「网络失败」误判为「目录为空/无照片」。
      throw new Error(
        parsed.error
          ? parsed.error
          : 'WebDAV 传输层异常（请检查地址/网络，或纯 http 是否被系统拦截）',
      );
    }
    const ab = base64ToBytes(parsed.base64);
    return {
      status: parsed.status,
      headers: parsed.headers ?? {},
      text: new TextDecoder().decode(ab),
      arrayBuffer: ab,
    };
  }
}
