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
            // 关闭 WebView 磁盘缓存：图片已走自有 blob 缓存，避免 WebView 数据目录额外占用存储
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            // 强制按 device-width 1:1 铺满全屏，避免被 WebView 自动缩放：
            //  - useWideViewPort=true 采用页面声明的 device-width 宽视口（不回退 980px 窄视口）
            //  - loadWithOverviewMode=false 关键！关闭「概述模式」缩放——否则部分 Android TV
            //    会把整页缩放以「概览」宽度，导致设置页内容缩成小框、四周留黑边
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

    /**
     * 遥控器按键拦截：
     *  - KEYCODE_MENU：系统默认用于弹出选项菜单，不会到达 WebView，转发给 __tvOpenSettings。
     *  - KEYCODE_BACK：转发给 window.__tvBack 由其决定：
     *      · 返回 true（设置页内导航已消费）→ 留在应用；
     *      · 返回 false（播放界面 / 首启未连接）→ 退出应用（finish）。
     *    此前无论 TS 返回什么都直接消费，导致播放界面按返回键无法退出，现按返回值处理。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
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
                        // __tvBack 返回布尔：true=已消费(留应用)，false=退出应用
                        val consumed = result != null && result.trim() == "true"
                        if (!consumed) runOnUiThread { finish() }
                    }
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
