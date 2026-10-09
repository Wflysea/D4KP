# 电视壁纸应用（NAS · WebDAV · TypeScript）

面向 **NAS 家庭用户** 的电视壁纸客户端开发骨架。以 **TypeScript 5.x（strict）** 为主要开发语言，通过 **WebDAV 协议（RFC 4918）** 直连用户 NAS 上的私有壁纸库，推送至智能电视大屏轮播。

本仓库对应《电视壁纸应用需求文档》与《软件设计实现方案》，提供可编译、可测试的工程骨架。

## 技术栈

| 类别 | 选型 |
|------|------|
| 语言 | TypeScript 5.x（`strict`） |
| 构建 | Vite 5 |
| 状态 | Zustand |
| 测试 | Vitest（单元）+ Playwright（端到端，待补） |
| 运行时 | 各 TV 端（Android TV / webOS / Tizen）+ Remote PWA |

## 目录结构

```
src/
├─ types/domain.ts        领域类型（§4）
├─ webdav/                WebDAV 适配层（§5）
│  ├─ types.ts            IWebdavClient 契约
│  ├─ client.ts           RFC4918 实现 + 并发限流
│  ├─ cert.ts             自签名证书指纹锁定
│  └─ adapters.ts         厂商识别与工厂
├─ core/
│  ├─ sync/               增量同步引擎（§6）
│  └─ playlist/           排程解析（§5.6）
├─ player/scheduler.ts    播放调度状态机（§7）
├─ remote/messages.ts     远程控制指令协议（§10）
├─ platform/
│  ├─ types.ts            平台能力抽象（PlatformHost / CredentialVault）
│  ├─ http/fetch.ts       真实 HttpClient 实现（§12）
│  └─ android-tv/         Android TV 平台桥接（§12）
│     ├─ bridge.ts        NativeBridge 契约 + getNativeBridge
│     ├─ host.ts          AndroidTvHost（常亮 / 设备信息 / 遥控）
│     ├─ android-http.ts  经原生桥的 WebDAV HttpClient
│     ├─ storage.ts       Keystore 凭据保险箱
│     ├─ content-cache.ts App 私有目录内容缓存
│     ├─ index.ts         createAndroidTvApp 聚合根
│     ├─ boot-core.ts      TV/手机共用的 WebView 引导内核（渲染/设置/连接）
│     ├─ entry.ts          Android TV 引导（遥控器输入）
│     └─ entry-phone.ts    手机版引导（触摸/滑动输入）
├─ storage/memory.ts      内存存储（开发/测试用，§9）
├─ app/                   组合根 + 状态仓库（§8）
└─ index.ts               库入口
test/                      Vitest 单元测试
```

## 常用脚本

```bash
pnpm install        # 安装依赖
pnpm typecheck      # tsc --noEmit 类型检查
pnpm test           # vitest run 运行单元测试
pnpm dev            # vite 开发服务器（Remote PWA / Web 端）
pnpm build          # 类型检查 + 产出 ESM 核心库
pnpm build:android  # 构建 Android TV WebView bundle（IIFE → android/app/.../assets/dist）
pnpm build:android-phone  # 构建手机版 WebView bundle（→ android/app-phone/.../assets/dist）
pnpm build:android-all    # 同时构建 TV + 手机两个 bundle
```

## 本地快速验证

1. `pnpm install`
2. `pnpm typecheck` —— 确认全量类型通过（strict 模式）
3. `pnpm test` —— 运行同步引擎 / 播放调度 / WebDAV 客户端三组单测

## 接入真实 NAS（开发 → 生产）

- 修改连接端点（`DavEndpoint`）：`server` 填 `https://你的NAS:5006`，`rootPath` 填壁纸目录；
- 将 `storage/memory` 的内存实现替换为平台存储（TV 端用 IndexedDB / 文件缓存，凭据走 Keystore/Keychain）；
- Web 端 / Remote PWA 直接复用 `FetchHttpClient`；Android TV / webOS / Tizen 提供各自的平台桥接（见设计文档 §12）；
- 端到端测试需 `npx playwright install` 安装浏览器后补充 `test/e2e`。

## Android TV 平台实现

Android TV 端采用 **WebView 宿主 + 原生 Kotlin 壳** 的架构（见设计文档 §12）：

- **TS 侧**（`src/platform/android-tv/`）实现平台能力抽象：WebDAV 请求经 `window.AndroidWallpaper.davRequest` 转交原生层发出（原生持有 NAS 凭证、支持自签名证书引脚、绕过 WebView TLS 限制），凭据走 Android Keystore 加密，壁纸二进制落 App 私有目录；
- **原生侧**（`android/` 下的 Kotlin 工程）提供 `MainActivity`（全屏 WebView + Leanback 启动器 + 常亮）+ `WallpaperBridge`（`@JavascriptInterface` 实现原生桥）；
- **构建链路**：`pnpm build:android` 把 `entry.ts` 打包为单一 IIFE，输出到 `android/app/src/main/assets/dist/android-tv.js`，由 `assets/index.html` 通过 `./dist/android-tv.js` 引入；手机版同理（`entry-phone.ts` → `android-phone.js`）。

> 原生 Kotlin 工程（`android/`，含 `:app` 电视版与 `:app-phone` 手机版两个模块）需在 **已配置 Android SDK 的环境**中用 `./gradlew assembleDebug` 编译调试版，或用 `bash android/sign-release.sh` 生成带签名的发布版。版本号统一在 `android/gradle.properties`（`appVersionCode` / `appVersionName`）。本仓库的 TS 逻辑已通过 `typecheck` + 20 项单元测试 + 两个 WebView bundle 构建验证。详见 [`android/README.md`](./android/README.md)。

## 发布与下载页

`/workspace/publish/` 是一个**自包含的静态下载页**：在其中打开 `index.html` 即可看到 TV / 手机两个版本的下载卡片（正式版 + 调试版，含版本号与大小），APK 安装包位于同目录 `apk/` 下，可直接随页面一起托管。

- 电视版呼出设置：**任意时刻按遥控器「菜单」键**即可重新打开设置面板（已修复首次设置后无法再次进入的问题）。
- HTTP NAS 已默认支持：两个 Manifest 已开启 `android:usesCleartextTraffic="true"`，纯 `http://` 的 WebDAV 也能直连；自签名 HTTPS 仍在设置中取消「校验 TLS 证书」即可。

## 设计约束回扣

- FE-01 WebDAV 连接 ↔ `webdav/client.ts`
- FE-03 同步缓存 ↔ `core/sync/sync-engine.ts`
- FE-04 播放引擎 ↔ `player/scheduler.ts`
- FE-07 远程控制 ↔ `remote/messages.ts`
- FE-08 安全隐私 ↔ `webdav/cert.ts`（默认零遥测，遥测开关在 `app` 层）
