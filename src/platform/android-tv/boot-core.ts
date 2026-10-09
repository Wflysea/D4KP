// platform/android-tv/boot-core.ts —— 电视 / 手机共用的 WebView 引导内核
// 负责：常亮、壁纸渲染、连接/同步/播放、NAS 设置表单；返回导航句柄供不同输入源调用。
// TV 端由遥控器（entry.ts）、手机端由触摸滑动（entry-phone.ts）分别驱动 nav。

import { createAndroidTvApp, type AndroidTvApp } from './index';
import { useAppStore } from '../../app/store';
import type { AppContext } from '../../app/compose-root';
import { isSystemPath } from '../../core/sync/sync-engine';
import { sha256Hex } from '../../webdav/cert';
import { sniffMime } from './content-cache';
import type { Playlist, WallpaperItem } from '../../types/domain';
import type { DavEndpoint } from '../../webdav/types';

export interface WallpaperNav {
  next(): void;
  prev(): void;
  openSettings(): void;
  /** OK 键/媒体键：暂停或恢复自动轮播 */
  togglePause(): void;
  /** 返回键：设置页内导航（文件夹浏览器 → 第 1 步），播放态忽略，绝不退出应用 */
  back(): void;
}

export interface BootResult {
  app: AndroidTvApp;
  nav: WallpaperNav;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

/** 拼接 NAS 路径（处理头尾多余斜杠），如 joinPath('/Photos','Wallpapers') => '/Photos/Wallpapers' */
function joinPath(base: string, seg: string): string {
  const b = base.replace(/\/+$/, '');
  const s = seg.replace(/^\/+/, '');
  if (!s) return b || '/';
  return (b || '') + '/' + s;
}

/**
 * 引导壁纸应用（电视/手机共用）。root 缺省时取 #app 或 body。
 * 返回 app 与 nav；nav 暴露 next/prev/openSettings 供遥控器或触摸调用。
 */
export async function bootWallpaperApp(root?: HTMLElement): Promise<BootResult> {
  const app = createAndroidTvApp();
  const elRaw =
    root ?? (typeof document !== 'undefined' ? (document.getElementById('app') ?? document.body) : null);
  const idle: BootResult = {
    app,
    nav: { next() {}, prev() {}, openSettings() {}, togglePause() {}, back() {} },
  };
  if (!elRaw) return idle;
  const el: HTMLElement = elRaw;

  // 壁纸常驻：保持屏幕常亮
  app.host.keepAwake(true);

  let setupOpen = false;
  /** 设置向导当前步骤：back 键据此做页面内导航（文件夹浏览器 → 第 1 步），不退出应用 */
  let setupStep: 'step1' | 'folders' | null = null;
  /** 当前设置上下文，供 back 键回退时重建第 1 步表单 */
  let setupCtx: {
    endpoint: DavEndpoint;
    dwellSec: number;
    order: 'sequential' | 'random';
    showClock?: boolean;
    showSpeed?: boolean;
  } | null = null;
  let currentUrl: string | null = null;
  /** 连接成功后的核心层上下文（懒加载下载图片时使用） */
  let davCtx: AppContext | null = null;
  /** 并发去重：同一张图同时触发多次渲染时只发一次请求 */
  const inflight = new Map<string, Promise<string | null>>();
  /** 自动轮播定时器（此前缺失，dwellSec 现真正生效） */
  let dwellTimer: ReturnType<typeof setTimeout> | null = null;
  /** 只轮播图片文件（视频/文档等一律不进播放列表） */
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif|tiff?)$/i;

  // —— 播放界面信息叠加层（时间 + 网速，可在设置中开关） ——
  let showClock = false;
  let showSpeed = false;
  let infoTimer: ReturnType<typeof setInterval> | null = null;
  /** 最近下载记录，用于计算最近 5 秒的平均网速 */
  const speedLog: { t: number; bytes: number }[] = [];

  function fmtSpeed(): string {
    const now = Date.now();
    while (speedLog.length > 0 && now - speedLog[0].t > 5000) speedLog.shift();
    if (speedLog.length === 0) return '⬇ —';
    const bytes = speedLog.reduce((a, b) => a + b.bytes, 0);
    const secs = Math.max(1, (now - speedLog[0].t) / 1000);
    const bps = bytes / secs;
    const v = bps >= 1048576 ? (bps / 1048576).toFixed(2) + ' MB/s' : (bps / 1024).toFixed(0) + ' KB/s';
    return '⬇ ' + v;
  }

  function updateInfo(): void {
    const info = el.querySelector('#atv-info');
    if (!info) return;
    const parts: string[] = [];
    if (showClock) {
      const d = new Date();
      parts.push(
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'),
      );
    }
    if (showSpeed) parts.push(fmtSpeed());
    info.textContent = parts.join('   ');
  }

  /** 按开关创建/隐藏叠加层；设置页打开时务必隐藏（由 renderStep1 归零后调用） */
  function applyInfoOverlay(): void {
    el.querySelector('#atv-info')?.remove();
    if (!showClock && !showSpeed) {
      if (infoTimer) {
        clearInterval(infoTimer);
        infoTimer = null;
      }
      return;
    }
    const d = document.createElement('div');
    d.id = 'atv-info';
    d.style.cssText =
      'position:fixed;right:24px;top:20px;background:rgba(0,0,0,.55);color:#fff;padding:8px 18px;border-radius:14px;font-size:22px;z-index:8;';
    el.appendChild(d);
    if (!infoTimer) infoTimer = setInterval(updateInfo, 1000);
    updateInfo();
  }

  /** 当前显示完成后，按 dwellSec 安排下一张自动切换（暂停时不安排） */
  function scheduleNext(): void {
    if (dwellTimer) clearTimeout(dwellTimer);
    dwellTimer = null;
    const s = useAppStore.getState();
    if (s.paused || s.items.length <= 1) return;
    const dwellMs = Math.max(3, s.playlist?.dwellSec ?? 15) * 1000;
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      const st = useAppStore.getState();
      if (st.paused || st.items.length === 0) return;
      st.dispatch({ type: 'TICK' });
      renderItem(currentItem());
    }, dwellMs);
  }

  /**
   * 预取下一批图片，切换时几乎零等待（用户反馈「切换慢」的主修复）。
   * 顺序模式取前后各一张；随机模式顺序邻居对随机无意义，改为预取 2 张随机候选。
   */
  function prefetchNeighbors(): void {
    const s = useAppStore.getState();
    const n = s.items.length;
    if (n === 0) return;
    if (s.playlist?.order === 'random') {
      const a = Math.floor(Math.random() * n);
      void fetchItemUrl(s.items[a]);
      void fetchItemUrl(s.items[(a + 1) % n]);
      return;
    }
    void fetchItemUrl(s.items[(s.index + 1) % n]);
    void fetchItemUrl(s.items[(s.index - 1 + n) % n]);
  }

  function showPausedBadge(on: boolean): void {
    const stage = el.querySelector('#atv-stage') as HTMLElement | null;
    if (!stage) return;
    if (on) {
      stage.style.position = 'relative';
      if (!stage.querySelector('#atv-paused')) {
        const d = document.createElement('div');
        d.id = 'atv-paused';
        d.textContent = '⏸ 已暂停（按 OK 键继续）';
        d.style.cssText =
          'position:absolute;left:50%;bottom:8%;transform:translateX(-50%);background:rgba(0,0,0,.72);color:#fff;padding:10px 24px;border-radius:24px;font-size:18px;z-index:9;';
        stage.appendChild(d);
      }
    } else {
      stage.querySelector('#atv-paused')?.remove();
    }
  }

  /**
   * 浏览式加载：播放到哪张才从 NAS 拉取哪张，不预下载整个目录。
   * 下载后按「账号|路径」内容寻址落盘缓存，再次显示直接命中本地缓存，不重复请求。
   */
  function fetchItemUrl(item: WallpaperItem): Promise<string | null> {
    const hit = inflight.get(item.path);
    if (hit) return hit;
    const p = (async (): Promise<string | null> => {
      if (!davCtx) return null;
      const key = await sha256Hex(
        new TextEncoder().encode(`${item.accountId}|${item.path}|`).buffer,
      );
      const cached = await app.cache.get(key);
      if (cached) return URL.createObjectURL(new Blob([cached], { type: sniffMime(cached) }));
      const buf = await davCtx.dav.get(item.path);
      speedLog.push({ t: Date.now(), bytes: buf.byteLength });
      await app.cache.put(buf, { accountId: item.accountId, path: item.path });
      return URL.createObjectURL(new Blob([buf], { type: sniffMime(buf) }));
    })()
      .catch(() => null)
      .finally(() => inflight.delete(item.path));
    inflight.set(item.path, p);
    return p;
  }

  function renderItem(item: WallpaperItem | undefined): void {
    const stage = el.querySelector('#atv-stage') as HTMLElement | null;
    if (!stage) return;
    if (!item) {
      stage.innerHTML = '<div id="atv-loading">没有可显示的图片</div>';
      return;
    }
    // 双缓冲：加载期间保留旧图（消除黑屏），仅在角落显示小提示；新图就绪后原子替换
    showLoadingBadge(true);
    void fetchItemUrl(item).then((url) => {
      const stageNow = el.querySelector('#atv-stage') as HTMLElement | null;
      if (!stageNow) return;
      showLoadingBadge(false);
      if (!url) {
        // 仅当屏幕上还没有任何图片时才覆盖为错误提示，否则保留旧图不打断观看
        if (!stageNow.querySelector('.atv-img')) {
          stageNow.innerHTML =
            '<div id="atv-loading">图片加载失败（可能已被移动或删除），请按左右键切换</div>';
        }
        return;
      }
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      currentUrl = url;
      stageNow.innerHTML = `<img class="atv-img" src="${url}" alt="" />`;
      if (useAppStore.getState().paused) showPausedBadge(true);
      try {
        localStorage.setItem('atv.lastPath', item.path); // 记住进度：重启后从这张继续
      } catch {
        /* 存储不可用时忽略 */
      }
      scheduleNext();
      prefetchNeighbors(); // 后台预取前后两张，下次切换即点即开
    });
  }

  /** 加载中的小提示（不遮挡旧图） */
  function showLoadingBadge(on: boolean): void {
    const stage = el.querySelector('#atv-stage') as HTMLElement | null;
    if (!stage) return;
    if (on) {
      stage.style.position = 'relative';
      if (!stage.querySelector('#atv-loading-badge')) {
        const d = document.createElement('div');
        d.id = 'atv-loading-badge';
        d.textContent = '⏳ 加载中…';
        d.style.cssText =
          'position:absolute;left:24px;top:20px;background:rgba(0,0,0,.55);color:#fff;padding:6px 16px;border-radius:16px;font-size:15px;z-index:9;';
        stage.appendChild(d);
      }
    } else {
      stage.querySelector('#atv-loading-badge')?.remove();
    }
  }

  function currentItem(): WallpaperItem | undefined {
    const s = useAppStore.getState();
    return s.items[s.index];
  }

  async function connectAndPlay(rootPath?: string): Promise<void> {
    setupOpen = false;
    setupStep = null;
    el.innerHTML = '<div id="atv-stage"><div id="atv-loading">正在连接 NAS…</div></div>';
    try {
      const ctx = await app.boot();
      davCtx = ctx;
      const saved = await app.vault.load();
      const root = rootPath ?? saved?.rootPath ?? '/';
      // 浏览模式：只扫描目录结构（元数据），不预下载任何图片；播放时按需拉取单张
      const all = await ctx.dav.listAll(root);
      const photos: WallpaperItem[] = all
        .filter((r) => !r.isCollection && !isSystemPath(r.href) && IMAGE_EXT.test(r.name))
        .map((r) => ({
          id: r.href,
          accountId: 'primary',
          path: r.href,
          kind: 'image' as const,
          tags: [],
          favorite: false,
        }));
      const playlist: Playlist = {
        id: 'default',
        name: 'NAS 壁纸',
        source: { type: 'directory', accountId: 'primary', root },
        order: saved?.order ?? 'sequential',
        transition: 'kenburns',
        dwellSec: saved?.dwellSec ?? 15,
      };
      showClock = saved?.showClock ?? false;
      showSpeed = saved?.showSpeed ?? false;
      useAppStore.getState().dispatch({ type: 'SCHEDULE', playlist, items: photos });
      if (photos.length === 0) {
        el.innerHTML = `<div id="atv-stage"><div id="atv-loading">目录「${escapeHtml(root)}」中没有图片文件，请在设置中更换路径</div></div>`;
      } else {
        // 续播：从上次显示的那张继续（重启不再从头开始）
        let lastPath: string | null = null;
        try {
          lastPath = localStorage.getItem('atv.lastPath');
        } catch {
          /* 存储不可用时忽略 */
        }
        if (lastPath) {
          const idx = photos.findIndex((p) => p.path === lastPath);
          if (idx > 0) useAppStore.getState().dispatch({ type: 'JUMP', index: idx });
        }
        applyInfoOverlay(); // 播放界面按设置显示时间/网速
        renderItem(currentItem());
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      el.innerHTML = `<div id="atv-stage"><div id="atv-loading">连接失败：${escapeHtml(msg)}（按菜单键重新设置）</div></div>`;
    }
  }

  /** 设置向导第 1 步：填写服务器与账号，先测试连接成功，再进入选目录 */
  async function renderStep1(prefill: {
    server: string;
    rootPath: string;
    username: string;
    password: string;
    verifySsl: boolean;
    dwellSec?: number;
    order?: 'sequential' | 'random';
    showClock?: boolean;
    showSpeed?: boolean;
  }): Promise<void> {
    setupOpen = true;
    setupStep = 'step1';
    showClock = false;
    showSpeed = false;
    applyInfoOverlay(); // 设置页隐藏时间/网速叠加层
    el.innerHTML = `
      <div id="atv-setup">
        <h1>连接 NAS</h1>
        <p class="atv-hint">先填写服务器地址与账号，连接成功后再选择壁纸目录。OpenList / Alist 用户：地址需以 <code>/dav</code> 结尾，如 <code>http://192.168.1.50:5244/dav</code>。</p>
        <form id="atv-form" class="atv-form">
          <label>服务器地址<input id="f-server" type="text" placeholder="http://192.168.1.50:5244/dav（OpenList）或 https://nas.local:5006" value="${escapeHtml(prefill.server)}" /></label>
          <label>用户名<input id="f-user" type="text" value="${escapeHtml(prefill.username)}" /></label>
          <label>密码<input id="f-pass" type="password" value="${escapeHtml(prefill.password)}" /></label>
          <label>自动更换间隔（秒，3–3600）<input id="f-dwell" type="text" inputmode="numeric" value="${Math.max(3, prefill.dwellSec ?? 15)}" /></label>
          <label class="atv-check"><input id="f-random" type="checkbox" ${prefill.order === 'random' ? 'checked' : ''} /> 随机播放（不勾选则按文件夹顺序）</label>
          <label class="atv-check"><input id="f-clock" type="checkbox" ${prefill.showClock ? 'checked' : ''} /> 播放界面显示当前时间</label>
          <label class="atv-check"><input id="f-speed" type="checkbox" ${prefill.showSpeed ? 'checked' : ''} /> 播放界面显示网速</label>
          <label class="atv-check"><input id="f-verify" type="checkbox" ${prefill.verifySsl === false ? '' : 'checked'} /> 校验 TLS 证书（自签名 NAS 请取消勾选）</label>
          <div id="atv-msg" class="atv-msg"></div>
          <div class="atv-actions">
            <button id="f-next" type="button" class="atv-btn">测试连接并继续</button>
            ${prefill.server ? '<button id="f-save" type="button" class="atv-btn">保存设置并播放</button>' : ''}
            ${prefill.server ? '<button id="f-clear" type="button" class="atv-btn atv-btn-ghost">清除已保存</button>' : ''}
          </div>
        </form>
      </div>`;

    const serverEl = el.querySelector('#f-server') as HTMLInputElement;
    serverEl.focus();
    const msgEl = el.querySelector('#atv-msg') as HTMLElement;

    /** 读取第 1 步表单的公共字段（f-next 与 f-save 共用） */
    function readForm(): {
      server: string;
      dwell: number;
      order: 'sequential' | 'random';
      clock: boolean;
      speed: boolean;
      base: DavEndpoint;
    } | null {
      const server = serverEl.value.trim();
      if (!server) {
        msgEl.textContent = '请填写服务器地址';
        return null;
      }
      const dwellRaw = parseInt((el.querySelector('#f-dwell') as HTMLInputElement).value, 10);
      const dwell = Number.isFinite(dwellRaw) && dwellRaw >= 3 ? Math.min(3600, dwellRaw) : 15;
      const order: 'sequential' | 'random' = (el.querySelector('#f-random') as HTMLInputElement)
        .checked
        ? 'random'
        : 'sequential';
      return {
        server,
        dwell,
        order,
        clock: (el.querySelector('#f-clock') as HTMLInputElement).checked,
        speed: (el.querySelector('#f-speed') as HTMLInputElement).checked,
        base: {
          server,
          rootPath: '/',
          username: (el.querySelector('#f-user') as HTMLInputElement).value,
          password: (el.querySelector('#f-pass') as HTMLInputElement).value,
          https: server.startsWith('https'),
          verifySsl: (el.querySelector('#f-verify') as HTMLInputElement).checked,
        },
      };
    }

    (el.querySelector('#f-next') as HTMLButtonElement).addEventListener('click', async () => {
      const f = readForm();
      if (!f) return;
      msgEl.textContent = '正在连接…';
      try {
        // 先保存并真正建立连接，验证服务器/账号可用，随后进入目录浏览
        await app.setEndpoint(f.base, f.dwell, f.order, f.clock, f.speed);
        const ctx = await app.boot();
        await ctx.dav.list('/', { depth: 1 }); // 验证根目录可读
        renderFolderBrowser(f.base, '/', f.dwell, f.order, f.clock, f.speed);
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        msgEl.innerHTML =
          `连接失败：${escapeHtml(m)}<br/><span class="atv-hint">自签名证书请取消勾选「校验 TLS 证书」；纯 http 地址请确认网络可达。</span>`;
      }
    });

    // 只改间隔/随机/显示开关时无需重新连接选目录：沿用已保存目录直接保存并回播放
    (el.querySelector('#f-save') as HTMLButtonElement | null)?.addEventListener('click', async () => {
      const f = readForm();
      if (!f) return;
      const ep: DavEndpoint = { ...f.base, rootPath: prefill.rootPath || '/' };
      msgEl.textContent = '正在保存…';
      try {
        await app.setEndpoint(ep, f.dwell, f.order, f.clock, f.speed);
        void connectAndPlay(ep.rootPath);
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        msgEl.textContent = `保存失败：${m}`;
      }
    });

    if (prefill.server) {
      (el.querySelector('#f-clear') as HTMLButtonElement | null)?.addEventListener('click', () => {
        app.vault.clear();
        void renderStep1({ server: '', rootPath: '/', username: '', password: '', verifySsl: true });
      });
    }
  }

  /**
   * 设置向导第 2 步：连接成功后，在 NAS 目录树里实际点选壁纸文件夹。
   * 不提供手动输入框——通过面包屑回跳、点子文件夹逐级下钻来浏览，最终「选择当前目录」确定。
   */
  function renderFolderBrowser(
    endpoint: DavEndpoint,
    currentPath: string,
    dwellSec: number,
    order: 'sequential' | 'random',
    showClockOpt?: boolean,
    showSpeedOpt?: boolean,
  ): void {
    setupOpen = true;
    setupStep = 'folders';
    setupCtx = { endpoint, dwellSec, order, showClock: showClockOpt, showSpeed: showSpeedOpt };
    const segs = currentPath.split('/').filter(Boolean);
    const crumbs = ['/'].concat(segs.map((_, i) => '/' + segs.slice(0, i + 1).join('/')));
    const crumbHtml = crumbs
      .map((c, i) => {
        const label = i === 0 ? '/' : segs[i - 1];
        return `<button type="button" class="atv-crumb" data-path="${escapeHtml(c)}">${escapeHtml(label)}</button>`;
      })
      .join('<span class="atv-sep"> / </span>');

    el.innerHTML = `
      <div id="atv-setup">
        <h1>选择壁纸文件夹</h1>
        <p class="atv-hint">已连接到 ${escapeHtml(endpoint.server)}，请浏览并选择包含图片的目录。</p>
        <div id="atv-msg" class="atv-msg"></div>
        <div class="atv-breadcrumb">${crumbHtml}</div>
        <div id="atv-folders" class="atv-folders"><div class="atv-loading">正在读取目录…</div></div>
        <div class="atv-actions">
          <button id="f-back" type="button" class="atv-btn atv-btn-ghost">返回上一步</button>
          <button id="f-pick" type="button" class="atv-btn">选择当前目录并开始</button>
        </div>
      </div>`;

    const msgEl = el.querySelector('#atv-msg') as HTMLElement;
    const foldersEl = el.querySelector('#atv-folders') as HTMLElement;

    el.querySelectorAll<HTMLButtonElement>('.atv-crumb').forEach((b) =>
      b.addEventListener('click', () =>
        renderFolderBrowser(endpoint, b.dataset.path || '/', dwellSec, order, showClockOpt, showSpeedOpt),
      ),
    );
    (el.querySelector('#f-back') as HTMLButtonElement).addEventListener('click', () =>
      renderStep1({
        server: endpoint.server,
        rootPath: endpoint.rootPath,
        username: endpoint.username,
        password: endpoint.password,
        verifySsl: endpoint.verifySsl,
        dwellSec,
        order,
        showClock: showClockOpt,
        showSpeed: showSpeedOpt,
      }),
    );
    (el.querySelector('#f-pick') as HTMLButtonElement).addEventListener('click', async () => {
      const ep: DavEndpoint = { ...endpoint, rootPath: currentPath };
      await app.setEndpoint(ep, dwellSec, order, showClockOpt, showSpeedOpt);
      void connectAndPlay(currentPath);
    });

    void (async () => {
      try {
        const ctx = await app.boot();
        const items = await ctx.dav.list(currentPath, { depth: 1 });
        const folders = items.filter((r) => r.isCollection && r.name);
        const folderNames = folders.map((r) => r.name);
        const fileCount = items.filter((r) => !r.isCollection && r.name).length;
        if (folderNames.length === 0) {
          foldersEl.innerHTML =
            fileCount > 0
              ? `<div class="atv-empty">此目录下没有子文件夹，但包含 ${fileCount} 个文件，可直接选择当前目录开始播放</div>`
              : '<div class="atv-empty">此目录下没有子文件夹，可直接选择当前目录</div>';
        } else {
          foldersEl.innerHTML = folderNames
            .map(
              (f) =>
                `<button type="button" class="atv-folder" data-folder="${escapeHtml(f)}">📁 ${escapeHtml(f)}</button>`,
            )
            .join('');
          foldersEl.querySelectorAll<HTMLButtonElement>('.atv-folder').forEach((b) =>
            b.addEventListener('click', () =>
              renderFolderBrowser(
                endpoint,
                joinPath(currentPath, b.dataset.folder ?? ''),
                dwellSec,
                order,
                showClockOpt,
                showSpeedOpt,
              ),
            ),
          );
          if (fileCount > 0) {
            msgEl.innerHTML = `<span class="atv-hint">当前目录含 ${fileCount} 个文件；建议进入子文件夹以缩小壁纸范围。</span>`;
          }
        }
        const first =
          foldersEl.querySelector<HTMLButtonElement>('.atv-folder') ??
          (el.querySelector('#f-pick') as HTMLButtonElement);
        first.focus();
      } catch (err: unknown) {
        const m = err instanceof Error ? err.message : String(err);
        msgEl.textContent = `读取目录失败：${m}`;
      }
    })();
  }

  /** 打开设置向导（菜单键或首启无凭证时调用） */
  async function openSetup(): Promise<void> {
    const saved = await app.vault.load();
    void renderStep1(
      saved ?? { server: '', rootPath: '/', username: '', password: '', verifySsl: true },
    );
  }

  // 导航句柄：设置态下忽略切图，避免表单误触
  const nav: WallpaperNav = {
    next() {
      if (setupOpen) return;
      useAppStore.getState().dispatch({ type: 'NEXT' });
      renderItem(currentItem());
    },
    prev() {
      if (setupOpen) return;
      useAppStore.getState().dispatch({ type: 'PREV' });
      renderItem(currentItem());
    },
    openSettings() {
      if (!setupOpen) void openSetup();
    },
    togglePause() {
      if (setupOpen) return;
      const s = useAppStore.getState();
      if (s.items.length === 0) return;
      s.dispatch({ type: 'TOGGLE_PAUSE' });
      if (useAppStore.getState().paused) {
        if (dwellTimer) {
          clearTimeout(dwellTimer);
          dwellTimer = null;
        }
        showPausedBadge(true);
      } else {
        showPausedBadge(false);
        scheduleNext(); // 恢复：从当前图重新计时
      }
    },
    back() {
      // 返回键：文件夹浏览器 → 第 1 步；第 1 步（有已保存配置）→ 退出设置回播放；永不误退应用
      if (setupStep === 'folders' && setupCtx) {
        const { endpoint, dwellSec, order, showClock, showSpeed } = setupCtx;
        void renderStep1({
          server: endpoint.server,
          rootPath: endpoint.rootPath,
          username: endpoint.username,
          password: endpoint.password,
          verifySsl: endpoint.verifySsl,
          dwellSec,
          order,
          showClock,
          showSpeed,
        });
        return;
      }
      if (setupStep === 'step1') {
        void (async () => {
          const sv = await app.vault.load();
          if (sv?.server) void connectAndPlay(sv.rootPath); // 已有配置：返回播放
        })();
      }
    },
  };

  // 首启：有凭证直接连，无凭证弹设置
  const saved = await app.vault.load();
  if (saved) void connectAndPlay(saved.rootPath);
  else void openSetup();

  return { app, nav };
}
