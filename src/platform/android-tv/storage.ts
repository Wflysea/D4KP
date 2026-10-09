// platform/android-tv/storage.ts —— 凭据保险箱（Android Keystore）
// 对应设计文档 §8 / §11：NAS 凭证加密持久化，明文只驻内存。

import type { CredentialVault, StoredCredential } from '../types';
import { getNativeBridge, bridgeLog, type NativeBridge } from './bridge';

const VAULT_KEY = 'atv.credential';

export class AndroidTvCredentialVault implements CredentialVault {
  // 无原生桥时的内存兜底（浏览器调试/测试）
  private mem: StoredCredential | null = null;

  constructor(private readonly bridge: NativeBridge | null = getNativeBridge()) {}

  async save(cred: StoredCredential): Promise<void> {
    this.mem = cred;
    if (this.bridge) {
      this.bridge.saveCredential(JSON.stringify(cred));
    } else if (typeof localStorage !== 'undefined') {
      localStorage.setItem(VAULT_KEY, JSON.stringify(cred));
    } else {
      bridgeLog(this.bridge, 'w', 'saveCredential: 无原生桥且无 localStorage，仅驻内存');
    }
  }

  async load(): Promise<StoredCredential | null> {
    if (this.bridge) {
      const raw = this.bridge.loadCredential();
      return raw ? (JSON.parse(raw) as StoredCredential) : null;
    }
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(VAULT_KEY);
      return raw ? (JSON.parse(raw) as StoredCredential) : null;
    }
    return this.mem;
  }

  async clear(): Promise<void> {
    this.mem = null;
    if (this.bridge) {
      this.bridge.clearCredential();
    } else if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(VAULT_KEY);
    }
  }
}
