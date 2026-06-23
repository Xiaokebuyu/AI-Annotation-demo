package com.inkloop.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * InkLoop 安卓壳：用 WebViewAssetLoader 从 APK 的 assets/ 加载 Vite 构建的前端，
 * AI 走托管代理（构建时 VITE_API_BASE_URL 注入）。安全侧用 https 风格的本地 origin、关 file 访问。
 *
 * 前端静态资源来自 `dist/`（见 scripts/sync-android-assets.mjs / INTEGRATION.md），
 * 端侧 OCR 桥见 OcrBridge（Phase 2）。
 */
class MainActivity : ComponentActivity() {

    companion object {
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val APP_URL = "https://appassets.androidplatform.net/assets/index.html"
    }

    private lateinit var webView: WebView
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    // PDF 导入：前端 <input type=file accept=application/pdf> → 系统 SAF 文档选择器。
    private val filePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val cb = pendingFileCallback ?: return@registerForActivityResult
        pendingFileCallback = null
        val uris = if (result.resultCode == Activity.RESULT_OK)
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data) else null
        cb.onReceiveValue(uris)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        setContentView(webView)
        configureWebView(assetLoader)

        // Phase 2（端侧 OCR）：拷入 POC 源码 + 加依赖后取消下一行注释 → 注册 window.InkLoopOcr 桥。
        // 套壳 MVP 阶段保持注释：window.InkLoopOcr 不存在 → 前端 ondevice.available()=false → 自动走云端识别。
        // com.example.hmpocrpoc.OcrBridge.attach(webView, this)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        webView.loadUrl(APP_URL)
    }

    private fun configureWebView(assetLoader: WebViewAssetLoader) {
        with(webView.settings) {
            javaScriptEnabled = true          // 前端是 Vite/TS 应用，必须开
            domStorageEnabled = true          // localStorage / IndexedDB（标注/账本持久化）
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            mediaPlaybackRequiresUserGesture = true
            setSupportZoom(false)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) safeBrowsingEnabled = true
        }

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assetLoader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val uri = request.url
                if (uri.host == APP_HOST) return false   // 应用内本地资源 → 放行
                // 任何外链交系统浏览器，不在 App 内打开任意网页。
                return try { startActivity(Intent(Intent.ACTION_VIEW, uri)); true }
                catch (_: ActivityNotFoundException) { true }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                pendingFileCallback?.onReceiveValue(null)
                pendingFileCallback = filePathCallback
                val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "application/pdf"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/pdf"))
                }
                return try { filePicker.launch(intent); true }
                catch (_: ActivityNotFoundException) {
                    pendingFileCallback = null; filePathCallback.onReceiveValue(null); false
                }
            }
        }
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
