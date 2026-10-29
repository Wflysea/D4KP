package com.example.tvwallpaper.phone

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * 手机版宿主 Activity：
 *  - 全屏 WebView 加载 assets/index.html（由 vite.android-phone.config.ts 构建的 bundle）
 *  - 通过 addJavascriptInterface 注入 WallpaperBridge，供 TS 调用原生能力
 *  - 壁纸常驻：FLAG_KEEP_SCREEN_ON 保持屏幕常亮
 * 交互由 TS 侧触摸手势驱动（见 src/platform/android-tv/entry-phone.ts）
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            // 强制按 device-width 1:1 铺满全屏，避免被 WebView 自动缩放（与 TV 版一致）：
            //  - useWideViewPort=true 采用页面声明的 device-width 宽视口
            //  - loadWithOverviewMode=false 关闭「概述模式」缩放，防止页面被缩放变小
            //  - setInitialScale(100) 锁定初始缩放 100%，textZoom=100 防系统大字体破坏布局
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = false
            settings.textZoom = 100
            // 锁定 WebView 初始缩放 100%，配合上面的设置确保 1:1 全屏（setInitialScale 属于 WebView 而非 WebSettings）
            setInitialScale(100)
            webViewClient = WebViewClient()
            addJavascriptInterface(WallpaperBridge(this@MainActivity), "AndroidWallpaper")
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(webView)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
