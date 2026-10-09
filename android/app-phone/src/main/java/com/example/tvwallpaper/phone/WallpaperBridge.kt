package com.example.tvwallpaper.phone

import android.app.Activity
import android.content.Context
import android.os.Build
import android.util.Base64
import android.util.Log
import android.view.WindowManager
import android.webkit.JavascriptInterface
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.SecureRandom
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * TS 侧通过 window.AndroidWallpaper 调用的原生桥（@JavascriptInterface）。
 * 与电视版完全一致的能力集（davRequest / 凭据加密 / blob 缓存 / 常亮 / 设备信息）。
 */
class WallpaperBridge(private val activity: Activity) {

    private val ctx: Context get() = activity.applicationContext
    private val blobsDir: File get() = ctx.getDir("blobs", Context.MODE_PRIVATE)

    // ---- 凭据（Android Keystore 加密）----
    private val creds: EncryptedSharedPreferences by lazy {
        val master = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            ctx,
            "tv_wallpaper_creds",
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        ) as EncryptedSharedPreferences
    }

    @JavascriptInterface
    fun saveCredential(json: String) {
        val o = JSONObject(json)
        creds.edit().apply {
            putString("server", o.optString("server"))
            putString("rootPath", o.optString("rootPath"))
            putString("username", o.optString("username"))
            putString("password", o.optString("password"))
            putBoolean("https", o.optBoolean("https", true))
            putBoolean("verifySsl", o.optBoolean("verifySsl", true))
            putString("certFingerprint", o.optString("certFingerprint", ""))
            apply()
        }
    }

    @JavascriptInterface
    fun loadCredential(): String? {
        if (!creds.contains("server")) return null
        return JSONObject().apply {
            put("accountId", "primary")
            put("server", creds.getString("server", ""))
            put("rootPath", creds.getString("rootPath", "/"))
            put("username", creds.getString("username", ""))
            put("password", creds.getString("password", ""))
            put("https", creds.getBoolean("https", true))
            put("verifySsl", creds.getBoolean("verifySsl", true))
            put("certFingerprint", creds.getString("certFingerprint", ""))
        }.toString()
    }

    @JavascriptInterface
    fun clearCredential() {
        creds.edit().clear().apply()
    }

    @JavascriptInterface
    fun keepAwake(on: Boolean) {
        activity.runOnUiThread {
            if (on) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    @JavascriptInterface
    fun getDeviceInfo(): String {
        val dm = ctx.resources.displayMetrics
        val pkg = runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }
            .getOrNull() ?: "1.0.0"
        return JSONObject().apply {
            put("model", Build.MODEL)
            put("sdkVersion", Build.VERSION.SDK_INT.toString())
            put("appVersion", pkg)
            put(
                "screen",
                JSONObject().apply {
                    put("width", dm.widthPixels)
                    put("height", dm.heightPixels)
                    put("dpi", dm.densityDpi)
                },
            )
        }.toString()
    }

    @JavascriptInterface
    fun davRequest(url: String, method: String, headersJson: String, body: String?): String {
        return try {
            val verifySsl = creds.getBoolean("verifySsl", true)
            val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                setRequestMethod(this, method)
                connectTimeout = 15_000
                readTimeout = 30_000
                val user = creds.getString("username", "") ?: ""
                val pass = creds.getString("password", "") ?: ""
                if (user.isNotEmpty()) {
                    val auth = Base64.encodeToString("$user:$pass".toByteArray(), Base64.NO_WRAP)
                    setRequestProperty("Authorization", "Basic $auth")
                }
                val h = JSONObject(headersJson)
                h.keys().forEach { k -> setRequestProperty(k, h.getString(k)) }
                if (this is HttpsURLConnection && !verifySsl) installInsecure(this)
                if (body != null) {
                    doOutput = true
                    outputStream.write(body.toByteArray(Charsets.UTF_8))
                }
            }
            val code = conn.responseCode
            val src = if (code < 400) conn.inputStream else conn.errorStream
            val bytes = src.readBytes()
            src.close()
            val headers = JSONObject()
            conn.headerFields.forEach { (k, v) -> if (k != null) headers.put(k, v.joinToString(", ")) }
            JSONObject().apply {
                put("status", code)
                put("headers", headers)
                put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            }.toString()
        } catch (e: Exception) {
            Log.e(TAG, "davRequest failed: ${e.message}")
            JSONObject().apply {
                put("status", 0)
                put("headers", JSONObject())
                put("base64", "")
                put("error", e.message ?: e.javaClass.simpleName)
            }.toString()
        }
    }

    /**
     * 设置 HTTP 方法。Android 的 HttpURLConnection.setRequestMethod() 只允许标准 8 种方法，
     * 而 WebDAV 需要 PROPFIND/PROPPATCH/REPORT/MKCOL/MOVE/COPY/LOCK/UNLOCK 等扩展方法。
     * 标准方法直接赋值即可；扩展方法通过反射设置私有字段 method 绕过校验，否则会抛
     * ProtocolException: Expected one of [...] but was 'PROPFIND'。
     */
    private fun setRequestMethod(conn: HttpURLConnection, method: String) {
        val up = method.uppercase()
        if (up in STANDARD_HTTP_METHODS) {
            conn.requestMethod = up
            return
        }
        var c: Class<*>? = conn.javaClass
        var field: java.lang.reflect.Field? = null
        while (c != null && field == null) {
            field = try { c.getDeclaredField("method") } catch (_: NoSuchFieldException) { null }
            c = c.superclass
        }
        field?.apply {
            isAccessible = true
            set(conn, up)
        } ?: run { conn.requestMethod = up }
    }

    /** verifySsl=false 时信任所有证书（仅用于自签名 NAS，凭证仍走加密存储） */
    private fun installInsecure(conn: HttpsURLConnection) {
        val trustAll = arrayOf<X509TrustManager>(object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
        })
        val ssl = SSLContext.getInstance("TLS").apply { init(null, trustAll, SecureRandom()) }
        conn.sslSocketFactory = ssl.socketFactory
        conn.hostnameVerifier = HostnameVerifier { _, _ -> true }
    }

    // ---- 内容寻址 blob 存储（App 私有目录）----
    @JavascriptInterface
    fun saveBlob(key: String, base64: String) {
        File(blobsDir, sanitize(key)).outputStream().use {
            it.write(Base64.decode(base64, Base64.NO_WRAP))
        }
    }

    @JavascriptInterface
    fun loadBlob(key: String): String? {
        val f = File(blobsDir, sanitize(key))
        if (!f.exists()) return null
        return Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun blobSize(): Int = blobsDir.listFiles()?.sumOf { it.length() }?.toInt() ?: 0

    @JavascriptInterface
    fun evictBlobs(quotaBytes: Int) {
        val files = blobsDir.listFiles()?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (f in files) {
            if (total <= quotaBytes) break
            total -= f.length()
            f.delete()
        }
    }

    @JavascriptInterface
    fun log(level: String, msg: String) {
        when (level) {
            "e" -> Log.e(TAG, msg)
            "w" -> Log.w(TAG, msg)
            "i" -> Log.i(TAG, msg)
            else -> Log.d(TAG, msg)
        }
    }

    private fun sanitize(key: String): String =
        key.replace(Regex("[^A-Za-z0-9_.-]"), "_")

    companion object {
        const val TAG = "NasWallpaper"
        private val STANDARD_HTTP_METHODS =
            setOf("GET", "POST", "HEAD", "OPTIONS", "PUT", "DELETE", "TRACE", "PATCH")
    }
}
