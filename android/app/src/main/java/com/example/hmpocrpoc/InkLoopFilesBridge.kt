package com.example.hmpocrpoc

import android.content.Context
import android.os.Environment
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * JS↔原生桥：window.InkLoopFiles —— 电纸屏 WebView 内文件浏览器。
 *
 * 为什么需要：电纸屏是 USB 推位图副屏，系统 SAF 文档选择器弹在内屏/HDMI、电纸屏看不见，
 * 故移动版前端自建「文件浏览器浮层」(#files)，由本桥喂 /sdcard 下的真实文件列表 + 字节。
 *
 * 前端契约（见 src/mobile-main.ts openFileBrowser，无桥时降级系统选择器）：
 *   list(path): String        → JSON `[{name,path,dir,size}]`（目录在前、按名排序；越权/无权限/不存在 = "[]"）
 *   readBase64(path): String  → 文件字节的 base64（NO_WRAP）；失败 = ""
 *
 * 同步方法、binder 线程执行；只「枚举 + 读」/sdcard 下文件，不写不删（越权回根）。
 * ⚠️大文件(>~10MB) base64 跨桥可能受限——典型书/日记 PDF(<5MB) 正常；超大档后续可加 readChunk(off,len)。
 * ⚠️Android 11+ 读 /sdcard/Download 任意文件需「所有文件访问」(MANAGE_EXTERNAL_STORAGE)；
 *   未授权时 listFiles()=null → 本桥返回 "[]"，前端浏览器空列表（MainActivity 启动时尝试请求一次）。
 *
 * 包名沿用徐的 com.example.hmpocrpoc，与 OcrBridge/EinkBridge 同包。
 */
class InkLoopFilesBridge(private val context: Context) {

    /** 列目录：返回 JSON `[{name,path,dir,size}]`。path 为传入路径风格（/sdcard 不解符号链接，与前端一致）。 */
    @JavascriptInterface
    fun list(path: String): String {
        return try {
            val dir = safeDir(path)
            val children = dir.listFiles()?.toList().orEmpty()
                .filterNot { it.name.startsWith(".") } // 跳隐藏
                .sortedWith(compareByDescending<File> { it.isDirectory }.thenBy { it.name.lowercase() })
            val arr = JSONArray()
            for (f in children) {
                arr.put(
                    JSONObject()
                        .put("name", f.name)
                        .put("path", f.path)
                        .put("dir", f.isDirectory)
                        .put("size", if (f.isFile) f.length() else 0L)
                )
            }
            arr.toString()
        } catch (_: Throwable) {
            "[]"
        }
    }

    /** 读文件字节 → base64（NO_WRAP）。仅限 /sdcard 下的普通文件；失败/越权回 ""。 */
    @JavascriptInterface
    fun readBase64(path: String): String {
        return try {
            val f = File(path)
            if (!f.isFile || !underRoot(f)) "" else Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
        } catch (_: Throwable) {
            ""
        }
    }

    // ── 边界：只允许外部存储根(/sdcard)下，越权回根 ──
    private fun root(): File = Environment.getExternalStorageDirectory()
    private fun underRoot(f: File): Boolean = try {
        f.canonicalPath.startsWith(root().canonicalPath)
    } catch (_: Throwable) {
        false
    }

    private fun safeDir(path: String): File {
        val candidate = if (path.isBlank()) File(root(), "Download") else File(path)
        return if (candidate.isDirectory && underRoot(candidate)) candidate else root()
    }

    companion object {
        private const val JS_OBJECT = "InkLoopFiles"

        /** 在 WebView 上注册 window.InkLoopFiles。MainActivity 在 loadUrl 前调用。 */
        @JvmStatic
        fun attach(webView: WebView, context: Context) {
            webView.addJavascriptInterface(InkLoopFilesBridge(context.applicationContext), JS_OBJECT)
        }
    }
}
