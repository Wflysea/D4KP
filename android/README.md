# Android 原生壳（Kotlin）—— 电视版 + 手机版

电视/手机壁纸应用的 Android 宿主工程：**全屏 WebView + 原生能力桥**。
TS 侧逻辑见 [`../src/platform/android-tv/`](../src/platform/android-tv/)，WebDAV 协议与同步/播放核心见主仓库 README。

本目录包含两个可独立安装的应用模块（共用同一套 TypeScript 内核）：

| 模块 | 包名 | 形态 | 入口 bundle |
|------|------|------|-------------|
| `:app` | `com.example.tvwallpaper` | Android TV（Leanback 启动器 + 遥控器） | `android-tv.js` |
| `:app-phone` | `com.example.tvwallpaper.phone` | 手机（触屏启动器 + 滑动） | `android-phone.js` |

两个模块共用 `gradle.properties` 里的 `appVersionCode` / `appVersionName`，改一处即统一升级。

## 架构

```
Android 设备
  └─ MainActivity（全屏 WebView，FLAG_KEEP_SCREEN_ON）
       └─ 加载 file:///android_asset/index.html
            └─ <script src="./dist/<android-tv|android-phone>.js">  ← pnpm build:android(:phone)
                 └─ bootWallpaperApp() 自动引导：连 NAS → 同步 → 装载播放列表
       └─ addJavascriptInterface(WallpaperBridge, "AndroidWallpaper")
            └─ window.AndroidWallpaper.*  ← TS 调用的原生能力
```

## 原生桥契约（TS ↔ Kotlin）

`WallpaperBridge` 通过 `@JavascriptInterface` 注入为 `window.AndroidWallpaper`，方法均同步返回（JSON / base64）：

| JS 调用 | 原生实现 | 说明 |
|---------|----------|------|
| `davRequest(url, method, headersJson, body)` | `WallpaperBridge.davRequest` | 发 WebDAV 请求，原生持有 Basic 凭证；`verifySsl=false` 时信任自签名证书；返回 `{status,headers,base64}` |
| `saveCredential(json)` / `loadCredential()` / `clearCredential()` | EncryptedSharedPreferences | NAS 凭证加密持久化（Android Keystore） |
| `keepAwake(on)` | `activity.window` FLAG_KEEP_SCREEN_ON | 壁纸常驻，保持屏幕常亮 |
| `getDeviceInfo()` | Build / displayMetrics | 返回 `{model,sdkVersion,appVersion,screen}` |
| `saveBlob(key, b64)` / `loadBlob(key)` / `blobSize()` / `evictBlobs(q)` | App 私有目录 `blobs/` | 内容寻址缓存落盘 |
| `log(level, msg)` | `android.util.Log` | 日志回传 Logcat |

> 对应 TS 契约文件：[`src/platform/android-tv/bridge.ts`](../src/platform/android-tv/bridge.ts)

## 输入方式差异

- **电视版**（`entry.ts`）：遥控器方向键 / OK 切图，`menu` 键打开设置，由 `AndroidTvHost.onRemoteKey` 在 TS 侧统一映射。
- **手机版**（`entry-phone.ts`）：轻点 / 上滑 / 左滑 → 下一帧，右滑 → 上一帧，下滑 → 打开设置（触摸手势在 TS 侧监听）。

## 构建与运行

### 前置
- 安装 **Android SDK**（API 34 编译 / minSdk 21），设置 `ANDROID_HOME`；
- 用 Android Studio 打开本 `android/` 目录（会自动生成 Gradle Wrapper）；或执行 `gradle wrapper`。

### 调试版（侧载自用）
```bash
# 1) 先构建两个 TS WebView bundle（各自输出到对应模块 assets/dist）
cd ..
pnpm install
pnpm build:android-all        # = build:android + build:android-phone

# 2) 编译并安装
cd android
./gradlew assembleDebug       # 产物分别在两个模块的 build/outputs/apk/debug/

# 电视版
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.example.tvwallpaper/.MainActivity

# 手机版（与电视版可共存）
adb install -r app-phone/build/outputs/apk/debug/app-phone-debug.apk
adb shell am start -n com.example.tvwallpaper.phone/.MainActivity
```

### 发布版（自带签名）
```bash
# 首次运行会自动生成 release-keystore.jks 与 keystore.properties，并用其签名
bash sign-release.sh
# 产物：app/build/outputs/apk/release/tv-wallpaper-<版本>-release.apk
#       app-phone/build/outputs/apk/release/tv-wallpaper-phone-<版本>-release.apk
```

## 接真实 NAS
1. 在 App 设置页填写服务器地址（如 `https://192.168.1.50:5006`）、壁纸目录、账号密码（自签名证书取消勾选「校验 TLS 证书」）；
2. `davRequest` 自动携带 Basic 认证，凭证经 Android Keystore 加密存储；
3. 电视版按菜单键重新设置；手机版下滑重新设置。

## 依赖
- `androidx.webkit:webkit` —— WebView
- `androidx.security:security-crypto` —— EncryptedSharedPreferences（Keystore 加密凭据）
- `androidx.core:core-ktx` / `kotlinx-coroutines-android` —— Kotlin 扩展

## 已构建产物（直接安装）

本工程已在已配置 Android SDK 的环境中成功编译，可直接安装的 APK 位于：

- **电视版（debug）**：`app/build/outputs/apk/debug/app-debug.apk`（约 3.0 MB）
- **手机版（debug）**：`app-phone/build/outputs/apk/debug/app-phone-debug.apk`（约 3.0 MB）
- **发布签名版**：`app/build/outputs/apk/release/app-release.apk` 与 `app-phone/build/outputs/apk/release/app-phone-release.apk`（执行 `bash sign-release.sh` 后生成）
- 带版本号的归档副本：**`/workspace/apk/`**（`tv-wallpaper-{tv|phone}-1.0.0-{debug|release}.apk`）

> 版本号统一在 `gradle.properties` 的 `appVersionCode` / `appVersionName`（当前均为 1 / 1.0.0），已写入两个 APK 的 `versionCode` / `versionName`。

### 在设备上安装（侧载）
设备需开启「开发者选项 → USB 调试」，然后用电脑 `adb` 推送：

```bash
# 网络（设备与电脑同一局域网）
adb connect <设备IP>:5555
adb install -r app/build/outputs/apk/debug/tv-wallpaper-1.0.0-debug.apk

# 或 U 盘 / 文件管理器侧载（需允许「未知来源」）
```

> 首次启动会弹出「NAS 壁纸设置」表单：填写服务器地址、壁纸目录、账号密码即可。
> 正式发布请用 `bash sign-release.sh` 生成带自己签名的 release APK（keystore.properties 已被 `.gitignore` 忽略）。
