import { describe, it, expect, vi } from 'vitest';
import type { NativeBridge } from '../src/platform/android-tv/bridge';
import { AndroidTvHttpClient } from '../src/platform/android-tv/android-http';
import { AndroidTvHost, mapRemoteKey } from '../src/platform/android-tv/host';
import { AndroidTvCredentialVault } from '../src/platform/android-tv/storage';
import { AndroidTvContentCache } from '../src/platform/android-tv/content-cache';
import { createAndroidTvApp } from '../src/platform/android-tv/index';

/** 内存实现的假原生桥，记录调用并满足 NativeBridge 契约 */
function makeFakeBridge() {
  const store = new Map<string, string>();
  let cred: string | null = null;
  const calls: Array<Record<string, unknown>> = [];
  const bridge: NativeBridge & { calls: typeof calls } = {
    calls,
    davRequest(url, method, headersJson, body) {
      calls.push({ davRequest: { url, method, headersJson, body } });
      // 返回 3 字节的 base64 负载（AAAA -> 0x00,0x00,0x00），便于校验往返
      return JSON.stringify({ status: 200, headers: { 'Content-Type': 'image/jpeg' }, base64: 'AAAA' });
    },
    saveCredential(json) {
      cred = json;
    },
    loadCredential() {
      return cred;
    },
    clearCredential() {
      cred = null;
    },
    keepAwake(on) {
      calls.push({ keepAwake: on });
    },
    getDeviceInfo() {
      return JSON.stringify({ model: 'FakeTV', sdkVersion: '33' });
    },
    saveBlob(key, b64) {
      store.set(key, b64);
    },
    loadBlob(key) {
      return store.get(key) ?? null;
    },
    blobSize() {
      return [...store.values()].reduce((n, s) => n + s.length, 0);
    },
    evictBlobs() {
      /* noop */
    },
    log() {
      /* noop */
    },
  };
  return bridge;
}

describe('AndroidTvHttpClient', () => {
  it('经原生桥发请求并解码 base64 响应', async () => {
    const bridge = makeFakeBridge();
    const http = new AndroidTvHttpClient(bridge);
    const res = await http.request('https://nas/wall.jpg', { method: 'GET' });
    expect(res.status).toBe(200);
    expect(res.arrayBuffer.byteLength).toBe(3); // 'AAAA' -> 3 字节
    expect(res.text).toBe('\u0000\u0000\u0000');
    expect(bridge.calls[0].davRequest).toMatchObject({ url: 'https://nas/wall.jpg', method: 'GET', headersJson: '{}' });
  });

  it('无原生桥时回退到 fetch 并注入 Basic 认证', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      headers: new Headers({ 'X-Test': '1' }),
      arrayBuffer: async () => new ArrayBuffer(2),
    }));
    const orig = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const http = new AndroidTvHttpClient(null, { username: 'u', password: 'p' });
      const res = await http.request('https://nas/x', { method: 'PROPFIND', headers: { Depth: '1' } });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const call = fetchMock.mock.calls[0] as unknown as [string, { headers: Headers }];
      const init = call[1];
      expect(init.headers.get('Authorization')).toContain('Basic ');
    } finally {
      globalThis.fetch = orig;
    }
  });
});

describe('AndroidTvHost', () => {
  it('keepAwake 转发到原生桥', () => {
    const bridge = makeFakeBridge();
    const host = new AndroidTvHost(bridge);
    host.keepAwake(true);
    expect(bridge.calls.some((c) => c.keepAwake === true)).toBe(true);
  });

  it('getDeviceInfo 合并原生 JSON 与平台标识', () => {
    const host = new AndroidTvHost(makeFakeBridge());
    const info = host.getDeviceInfo();
    expect(info.os).toBe('android-tv');
    expect(info.model).toBe('FakeTV');
  });
});

describe('mapRemoteKey', () => {
  it('方向键/enter/play 映射', () => {
    expect(mapRemoteKey('ArrowLeft', '')).toBe('left');
    expect(mapRemoteKey('ArrowRight', '')).toBe('right');
    expect(mapRemoteKey(' ', '')).toBe('enter');
    expect(mapRemoteKey('p', '')).toBe('play');
    expect(mapRemoteKey('x', '')).toBeNull();
  });
});

describe('AndroidTvCredentialVault', () => {
  it('save/load/clear 走原生桥', async () => {
    const bridge = makeFakeBridge();
    const vault = new AndroidTvCredentialVault(bridge);
    await vault.save({
      accountId: 'primary',
      server: 'https://n',
      rootPath: '/w',
      username: 'u',
      password: 'p',
      https: true,
      verifySsl: false,
    });
    const loaded = await vault.load();
    expect(loaded?.server).toBe('https://n');
    expect(loaded?.username).toBe('u');
    await vault.clear();
    expect(await vault.load()).toBeNull();
  });
});

describe('AndroidTvContentCache', () => {
  it('put/get 经原生 blob 存储往返', async () => {
    const bridge = makeFakeBridge();
    const cache = new AndroidTvContentCache(bridge);
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const key = await cache.put(buf, { accountId: 'a', path: '/x.jpg', etag: 'e1' });
    expect(typeof key).toBe('string');
    const got = await cache.get(key);
    expect(got).not.toBeNull();
    expect(new Uint8Array(got!)).toEqual(new Uint8Array([1, 2, 3, 4]));
  });
});

describe('createAndroidTvApp', () => {
  it('无桥环境可装配核心层上下文（默认端点）', async () => {
    const app = createAndroidTvApp(); // 测试环境 window 未定义 -> 桥为 null
    const ctx = await app.boot();
    expect(ctx.dav).toBeDefined();
    expect(ctx.sync).toBeDefined();
    await app.setEndpoint({
      server: 'https://n',
      rootPath: '/w',
      username: 'u',
      password: 'p',
      https: true,
      verifySsl: true,
    });
    const loaded = await app.vault.load();
    expect(loaded?.server).toBe('https://n');
  });
});
