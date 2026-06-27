package com.inkloop.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.Gravity
import android.view.View
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
        // 电纸屏壳加载移动版前端（mobile.html，reMarkable 黑白·单画布·会议/dev/书籍全接真）。
        // 桌面 web 仍由 index.html 提供（浏览器访问）；两页都打进 assets（vite 多页构建）。
        private const val APP_URL = "https://appassets.androidplatform.net/assets/mobile.html"
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
        // 设备形态=竖向电纸屏(IT8951 面板 3:4)。不改 activity 朝向(本板显示固定横向，
        // requestedOrientation=PORTRAIT 会卡死 activity)，而是把 WebView 本体做成 3:4 竖框：
        //  · 前端按窄屏(≤640) 走手机版竖屏布局；
        //  · PixelCopy 抓这块竖框 → EinkBridge TRANSVERSE → 满幅填到电纸屏(同 3:4，无黑边)。
        // 沉浸式全屏隐藏系统栏，给电纸屏满幅，也为后续 launcher/kiosk 形态铺路。
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )

        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(APP_HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        // 3:4 竖框，按物理屏高算宽(电纸屏 1404:1872)，居中放在深色底上(HDMI/内屏剩余区留黑边)。
        val screenH = resources.displayMetrics.heightPixels
        val portraitW = screenH * 3 / 4
        webView = WebView(this)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.parseColor("#11110f")) }
        root.addView(webView, FrameLayout.LayoutParams(portraitW, screenH).apply { gravity = Gravity.CENTER })
        setContentView(root)
        configureWebView(assetLoader)

        // 端侧印刷区域 OCR 桥：注册 window.InkLoopOcr（ocrRegion=ML Kit text+PP-OCR 兜底）。
        // 注册后前端 ondevice.available()=true → ocrRegion 走端侧；recognizeInk 端侧返回 unavailable → 前端自动降级云端。
        // 要纯套壳（全部走云）只需注释下一行。
        com.example.hmpocrpoc.OcrBridge.attach(webView, this)

        // 电纸屏推帧桥：注册 window.InkLoopEink。前端内容变化发 pageReady → PixelCopy 抓帧 → 灰度 →
        // abstract socket 交 eink-helper(root) 推 IT8951 电纸屏。无 helper/无电纸屏时静默失败、不影响 HDMI 显示。
        com.example.hmpocrpoc.EinkBridge.attach(webView, this)

        // WebView 内文件浏览器桥：注册 window.InkLoopFiles（list/readBase64 /sdcard）。
        // 电纸屏系统 SAF 选择器看不见 → 移动版导入走 #files 浮层，由本桥喂真实文件；无桥则前端降级系统选择器。
        com.example.hmpocrpoc.InkLoopFilesBridge.attach(webView, this)
        ensureAllFilesAccess() // Android 11+ 读 /sdcard 任意文件需「所有文件访问」，启动时尝试请求一次

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack()
                else { isEnabled = false; onBackPressedDispatcher.onBackPressed() }
            }
        })

        webView.loadUrl(APP_URL)
    }

    private fun configureWebView(assetLoader: WebViewAssetLoader) {
        val debuggable = (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
        with(webView.settings) {
            javaScriptEnabled = true          // 前端是 Vite/TS 应用，必须开
            domStorageEnabled = true          // localStorage / IndexedDB（标注/账本持久化）
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION") allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION") allowUniversalAccessFromFileURLs = false
            // 内容在 https appassets origin。debug 构建联调内网 http 代理(10.4.36.30，与 debug network_security_config 一致)
            //   需放行主动混合内容(fetch)，否则 AI/识别 /api/* 被拦；release 严格只走 https，禁混合内容。
            mixedContentMode = if (debuggable) WebSettings.MIXED_CONTENT_ALWAYS_ALLOW else WebSettings.MIXED_CONTENT_NEVER_ALLOW
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

    /** Android 11+ 读 /sdcard 任意文件需「所有文件访问」。未授权则拉一次系统授权页（best-effort，失败静默）。
     *  电纸屏定制板多半可直接授予/已授；授权后 InkLoopFilesBridge.list 才能枚举到 /sdcard/Download 的书。 */
    private fun ensureAllFilesAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return // 旧系统走 manifest READ_EXTERNAL_STORAGE
        if (Environment.isExternalStorageManager()) return
        try {
            startActivity(
                Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName"))
            )
        } catch (_: ActivityNotFoundException) {
            try { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) } catch (_: Throwable) { /* 静默 */ }
        }
    }

    override fun onDestroy() {
        if (this::webView.isInitialized) webView.destroy()
        super.onDestroy()
    }
}
