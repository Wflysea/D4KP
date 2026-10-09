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
