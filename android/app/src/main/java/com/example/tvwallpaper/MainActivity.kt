package com.example.tvwallpaper

import android.app.Activity
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Android TV 宿主 Activity：
 *  - 以全屏 WebView 加载 assets/index.html（由 vite.android-tv.config.ts 构建的 bundle）
 *  - 通过 addJavascriptInterface 注入 WallpaperBridge，供 TS 调用原生能力
 *  - 壁纸常驻：FLAG_KEEP_SCREEN_ON 保持屏幕常亮
 *  - 遥控器「菜单」键（KEYCODE_MENU）被系统用于弹出选项菜单，默认不会派发到 WebView，
 *    因此在此拦截并转发为合成 DOM 键盘事件，使 TS 侧能再次打开设置面板。
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

    /**
     * 遥控器菜单键（KEYCODE_MENU）默认被系统用于弹出选项菜单，不会作为 DOM 键盘事件到达
     * WebView，因此「设置」无法再次呼出。这里拦截它并直接调用 TS 暴露的全局函数
     * window.__tvOpenSettings（见 entry.ts），稳定地重新打开设置面板；return true 消费该按键。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_MENU) {
            webView.evaluateJavascript("window.__tvOpenSettings && window.__tvOpenSettings()", null)
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
