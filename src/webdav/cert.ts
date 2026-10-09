// webdav/cert.ts —— 自签名证书指纹锁定（设计文档 §5.4）

/** 归一化指纹：去分隔符、转小写 */
export function normalizeFingerprint(fp: string): string {
  return fp.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

/** 校验观察到的证书指纹是否与已钉引脚一致 */
export function fingerprintMatches(pinned: string, observed: string): boolean {
  return normalizeFingerprint(pinned) === normalizeFingerprint(observed);
}

/** 计算 ArrayBuffer 的 SHA-256 十六进制（使用跨平台 Web Crypto，浏览器/Node 通用） */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
