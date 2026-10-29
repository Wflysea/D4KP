package com.example.tvwallpaper

import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * 统一宿主 Activity：同一个 APK 同时支持「电视模式」与「手机模式」。
 *
 *  - 模式持久化于 SharedPreferences("app_prefs").app_mode（tv / phone）；
 *    首次启动按设备类型自动判定：Android TV → tv，其余（手机/平板）→ phone。
 *  - 电视模式：横屏；遥控器 菜单键 → __tvOpenSettings，返回键 → __tvBack。
 *  - 手机模式：竖屏；系统返回键/返回手势 → __phoneBack。
 *  - assets/index.html 依据 getAppMode() 动态加载 dist/android-tv.js 或 dist/android-phone.js。
 *  - 用户在设置页切换模式后，由 WallpaperBridge.setAppMode 调 applyModeAndReload()：
 *    存值 → 调整屏幕方向 → 重载页面，切换到对应交互层，无需重启应用。
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    private val prefs by lazy { getSharedPreferences("app_prefs", Context.MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        applyOrientation(currentMode())

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.allowFileAccess = true
            // 关闭 WebView 磁盘缓存：图片已走自有 blob 缓存，避免 WebView 数据目录额外占用存储
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            // 强制按 device-width 1:1 铺满全屏，避免被 WebView 自动缩放：
            //  - useWideViewPort=true 采用页面声明的 device-width 宽视口
            //  - loadWithOverviewMode=false 关闭「概述模式」缩放（否则 TV 上设置页会缩成小框）
            //  - setInitialScale(100) 锁定初始缩放 100%，textZoom=100 防系统大字体破坏布局
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = false
            settings.textZoom = 100
            setInitialScale(100)
            webViewClient = WebViewClient()
            addJavascriptInterface(WallpaperBridge(this@MainActivity), "AndroidWallpaper")
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(webView)
    }

    /** 默认模式：TV 设备 → tv，其它 → phone */
    private fun defaultMode(): String {
        val ui = getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
        return if (ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION) "tv" else "phone"
    }

    private fun currentMode(): String = prefs.getString("app_mode", null) ?: defaultMode()

    private fun applyOrientation(mode: String) {
        requestedOrientation = if (mode == "tv") {
            ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
    }

    /** 由 WallpaperBridge.setAppMode 调用：切换方向并重载页面到对应模式的交互层 */
    fun applyModeAndReload(mode: String) {
        runOnUiThread {
            applyOrientation(mode)
            webView.reload()
        }
    }

    /**
     * 电视模式按键拦截：
     *  - KEYCODE_MENU：系统默认用于弹出选项菜单、不会到达 WebView，转发给 __tvOpenSettings。
     *  - KEYCODE_BACK：转发给 __tvBack 由其决定（设置页内导航→消费；播放界面→退出）。
     * 手机模式不拦截，交给 onBackPressed 走 __phoneBack。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (currentMode() == "tv") {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MENU -> {
                    webView.evaluateJavascript("window.__tvOpenSettings && window.__tvOpenSettings()", null)
                    return true
                }
                KeyEvent.KEYCODE_BACK -> {
                    if (event.action == KeyEvent.ACTION_DOWN) {
                        webView.evaluateJavascript(
                            "window.__tvBack ? window.__tvBack() : true",
                        ) { result ->
                            val consumed = result != null && result.trim() == "true"
                            if (!consumed) runOnUiThread { finish() }
                        }
                    }
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** 手机模式：系统返回键 / 返回手势 → __phoneBack（true=已消费留在应用，false=退出） */
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (currentMode() == "tv") {
            super.onBackPressed()
            return
        }
        webView.evaluateJavascript(
            "(typeof window.__phoneBack === 'function') ? !!window.__phoneBack() : false",
        ) { consumed ->
            if (consumed != "true") finish()
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
