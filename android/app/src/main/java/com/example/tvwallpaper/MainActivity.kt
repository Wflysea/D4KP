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
            // TV 分辨率/密度差异大：宽视口 + 概览模式让页面按 device-width 铺满全屏，
            // 修复设置页内容缩小到屏幕左上角的问题；固定 textZoom 防系统大字体破坏布局
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.textZoom = 100
            webViewClient = WebViewClient()
            addJavascriptInterface(WallpaperBridge(this@MainActivity), "AndroidWallpaper")
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(webView)
    }

    /**
     * 遥控器按键拦截：
     *  - KEYCODE_MENU：系统默认用于弹出选项菜单，不会到达 WebView，转发给 __tvOpenSettings。
     *  - KEYCODE_BACK：默认行为是退出 Activity。壁纸应用应常驻——返回键改为转发给
     *    window.__tvBack，由 TS 侧决定「设置页内返回」或「播放态忽略」，永不误退应用。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        when (event.keyCode) {
            KeyEvent.KEYCODE_MENU -> {
                webView.evaluateJavascript("window.__tvOpenSettings && window.__tvOpenSettings()", null)
                return true
            }
            KeyEvent.KEYCODE_BACK -> {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    webView.evaluateJavascript("window.__tvBack && window.__tvBack()", null)
                }
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
