package com.firesense.kids

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.FileNotFoundException
import java.io.IOException
import java.net.URLConnection

/**
 * FireSense Kids for Fire TV.
 *
 * A thin WebView shell around the statically exported `/tv` page, which ships inside the
 * APK (assets/web) and is served from https://appassets.androidplatform.net so it runs in a
 * secure context without any local server. All logic lives in the web page; this class only
 * bridges what a web page cannot do on a TV: remote keys, app lifecycle, persistent storage,
 * and exiting the app.
 */
class MainActivity : Activity() {

    private lateinit var webView: WebView

    private val assetLoader by lazy {
        WebViewAssetLoader.Builder()
            .addPathHandler("/", WebAssetsPathHandler(this))
            .build()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView = WebView(this).apply {
            // Opaque on purpose: it also hides the hidden "overlay holder" video's SurfaceView
            // (lib/client/awv-overlay.ts), which Amazon WebView places behind this view.
            setBackgroundColor(android.graphics.Color.BLACK)
            isFocusable = true
            isFocusableInTouchMode = true
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
        }
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false // autoplay the cartoon on launch
            allowFileAccess = false
            allowContentAccess = false
        }
        webView.addJavascriptInterface(NativeBridge(this), "FiresenseNative")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Stay inside the bundled app; never navigate the TV to external pages.
                return request.url.host != APP_HOST
            }
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.i(TAG, "[web] ${message.messageLevel()} ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        setContentView(webView)
        webView.requestFocus()

        if (savedInstanceState == null) webView.loadUrl(START_URL) else webView.restoreState(savedInstanceState)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        dispatchToWeb("firesense:lifecycle", "{state:'resume'}")
    }

    override fun onPause() {
        // Tell the page first so it can send viewing_state {playing:false} and save the summary.
        dispatchToWeb("firesense:lifecycle", "{state:'pause'}")
        webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    /** Remote keys the WebView does not deliver to JavaScript by itself. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_BACK -> {
                    dispatchToWeb("firesense:back", "{}")
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                KeyEvent.KEYCODE_MEDIA_PLAY,
                KeyEvent.KEYCODE_MEDIA_PAUSE -> {
                    dispatchToWeb("firesense:key", "{key:'playpause'}")
                    return true
                }
                KeyEvent.KEYCODE_MENU -> {
                    dispatchToWeb("firesense:key", "{key:'menu'}")
                    return true
                }
                // ⏩ / ⏪ seek within the video; next / previous change the video. (The render benchmark
                // and the relay round trip are started from the TV's measurement menu.)
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
                    dispatchToWeb("firesense:key", "{key:'seekForward'}")
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_REWIND -> {
                    dispatchToWeb("firesense:key", "{key:'seekBack'}")
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_NEXT -> {
                    dispatchToWeb("firesense:key", "{key:'next'}")
                    return true
                }
                KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                    dispatchToWeb("firesense:key", "{key:'previous'}")
                    return true
                }
            }
        } else if (event.action == KeyEvent.ACTION_UP && event.keyCode == KeyEvent.KEYCODE_BACK) {
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun dispatchToWeb(name: String, detail: String) {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('$name', {detail: $detail}));",
            null,
        )
    }

    /** Exposed to JavaScript as `window.FiresenseNative`. Values persist in SharedPreferences. */
    class NativeBridge(private val activity: Activity) {
        private val prefs = activity.getSharedPreferences("firesense", Context.MODE_PRIVATE)

        @JavascriptInterface
        fun getItem(key: String): String? = prefs.getString(key, null)

        @JavascriptInterface
        fun setItem(key: String, value: String) {
            prefs.edit().putString(key, value).apply()
        }

        @JavascriptInterface
        fun removeItem(key: String) {
            prefs.edit().remove(key).apply()
        }

        @JavascriptInterface
        fun exitApp() {
            activity.runOnUiThread { activity.finish() }
        }
    }

    /**
     * Serves assets/web/<path>, resolving directory URLs to index.html (Next.js trailingSlash export).
     * Missing files return 404 rather than a fallback page.
     */
    class WebAssetsPathHandler(private val context: Context) : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): WebResourceResponse {
            val clean = Uri.decode(path).trimStart('/')
            val file = when {
                clean.isEmpty() -> "index.html"
                clean.endsWith("/") -> "${clean}index.html"
                else -> clean
            }
            return try {
                val stream = context.assets.open("web/$file")
                WebResourceResponse(mimeType(file), null, stream)
            } catch (e: FileNotFoundException) {
                Log.w(TAG, "404 web/$file")
                WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
            } catch (e: IOException) {
                Log.e(TAG, "error reading web/$file", e)
                WebResourceResponse("text/plain", "utf-8", 500, "Asset Error", emptyMap(), (e.message ?: "").byteInputStream())
            }
        }

        private fun mimeType(file: String): String = when (file.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "txt" -> "text/plain"
            "wasm" -> "application/wasm"
            "mp4" -> "video/mp4"
            "svg" -> "image/svg+xml"
            "woff2" -> "font/woff2"
            else -> URLConnection.guessContentTypeFromName(file) ?: "application/octet-stream"
        }
    }

    companion object {
        private const val TAG = "FireSenseKids"
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val START_URL = "https://$APP_HOST/tv/"
    }
}
