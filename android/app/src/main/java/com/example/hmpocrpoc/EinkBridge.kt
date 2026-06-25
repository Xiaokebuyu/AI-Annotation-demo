package com.example.hmpocrpoc

import android.app.Activity
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Window
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * EinkBridge —— 把 InkLoop 画板渲染帧推到 IT8951 电纸屏（USB）。
 *
 * 链路：WebView 画面 --本桥--> abstract unix socket "inkloop_eink" --> eink-helper(root,持 /dev/sg0) --> 面板。
 * 电纸屏不是系统显示器（USB 非显示总线），只能推帧；helper 常驻持设备+上电，本桥负责抓帧+灰度+发送。
 *
 * 前端契约（window.InkLoopEink，见 src/surface/eink.ts）：
 *   整屏：postMessage {"method":"pageReady","mode":2}
 *         → PixelCopy 抓整 WebView → 等比缩进竖向视图+白底补满 → TRANSVERSE → 8bpp 灰度 → 推 helper(GC16 整屏)
 *   局部：postMessage {"method":"inkArea","x":nx,"y":ny,"w":nw,"h":nh,"mode":4}（nx..归一化视口矩形=该笔 bbox）
 *         → 同样 PixelCopy 整屏(保持 fit 比例一致) → 只取该笔映射到帧缓冲的子矩形 → 推 helper(A2 局部快刷)
 *
 * 帧协议（与 eink-helper 一致，小端）：[u32 magic|i32 x|i32 y|i32 w|i32 h|i32 mode][w*h 字节灰度]
 *
 * 注：API 33 无 PixelCopy.request(View,...)（那是 API 34+），故用 request(Window,Rect,...)（API 26+）抓 WebView 区域。
 * 同包 com.example.hmpocrpoc，与 OcrBridge 并列；MainActivity 在 OcrBridge.attach 之后调 attach。
 */
object EinkBridge {

    private const val JS_OBJECT = "InkLoopEink"
    private val ALLOWED_ORIGINS = setOf("https://appassets.androidplatform.net")
    private const val SOCK_NAME = "inkloop_eink"   // abstract namespace
    private const val MAGIC = 0xE19C51AA.toInt()
    private const val EINK_W = 1872          // IT8951 帧缓冲原生尺寸（横向）
    private const val EINK_H = 1404
    private const val VIEW_W = 1404          // 竖向"期望视图"（用户正立看到的）：1404 宽 × 1872 高
    private const val VIEW_H = 1872
    private const val MODE_GC16 = 2
    private const val MODE_A2 = 4
    private const val INK_PAD = 14           // 局部矩形四周余量（帧缓冲 px），给 A2 留边、防裁掉笔锋

    private val main = Handler(Looper.getMainLooper())
    private var sock: LocalSocket? = null
    @Volatile private var busy = false       // 上一帧未推完则不并发；局部帧改"暂存并集"等推完再补，整屏帧直接丢
    private var pendingInk: FloatArray? = null   // 忙时累积的局部并集 [nx,ny,nw,nh]（视口归一化）

    @JvmStatic
    fun attach(webView: WebView, context: Context) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        WebViewCompat.addWebMessageListener(webView, JS_OBJECT, ALLOWED_ORIGINS) { view, message, _, _, _ ->
            val raw = message.data ?: return@addWebMessageListener
            val req = try { JSONObject(raw) } catch (_: Throwable) { return@addWebMessageListener }
            when (req.optString("method")) {
                "pageReady" -> main.post { mirrorFull(view, req.optInt("mode", MODE_GC16)) }
                "inkArea" -> main.post {
                    mirrorInk(
                        view,
                        req.optDouble("x", 0.0).toFloat(), req.optDouble("y", 0.0).toFloat(),
                        req.optDouble("w", 0.0).toFloat(), req.optDouble("h", 0.0).toFloat(),
                    )
                }
            }
        }
    }

    /** 整屏：PixelCopy 抓 WebView → fit+TRANSVERSE 全帧灰度 → 推 helper(GC16)。 */
    private fun mirrorFull(webView: WebView, mode: Int) {
        if (busy) return
        capture(webView) { vpx ->
            pushFrame(0, 0, EINK_W, EINK_H, mode, transverseRegion(vpx, 0, 0, EINK_W, EINK_H))
        }
    }

    /** 局部：抓整屏(保持 fit 比例) → 算该笔映射到帧缓冲的子矩形 → 仅取该子矩形灰度 → 推 helper(A2)。 */
    private fun mirrorInk(webView: WebView, nx: Float, ny: Float, nw: Float, nh: Float) {
        if (busy) { stashInk(nx, ny, nw, nh); return }
        val sw = webView.width; val sh = webView.height
        if (sw <= 0 || sh <= 0) return
        val fb = inkFbRect(sw, sh, nx, ny, nw, nh) ?: return
        capture(webView) { vpx ->
            pushFrame(fb[0], fb[1], fb[2], fb[3], MODE_A2, transverseRegion(vpx, fb[0], fb[1], fb[2], fb[3]))
        }
    }

    /** PixelCopy 抓整 WebView 区域 → 后台线程构出"竖向视图像素" → 交回调推帧。必须主线程发起 PixelCopy。 */
    private fun capture(webView: WebView, emit: (IntArray) -> Unit) {
        val w = webView.width; val h = webView.height
        if (w <= 0 || h <= 0) return
        val window: Window = (webView.context as? Activity)?.window ?: return
        busy = true
        val loc = IntArray(2); webView.getLocationInWindow(loc)
        val rect = Rect(loc[0], loc[1], loc[0] + w, loc[1] + h)
        val shot = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        try {
            PixelCopy.request(window, rect, shot, { res ->
                if (res != PixelCopy.SUCCESS) { shot.recycle(); finishPush(webView); return@request }
                Thread {
                    try { emit(buildViewPixels(shot)) }
                    catch (_: Throwable) {}
                    finally { shot.recycle(); finishPush(webView) }
                }.start()
            }, main)
        } catch (_: Throwable) { shot.recycle(); finishPush(webView) }
    }

    /** 截图 → 等比 fit 进竖向视图(VIEW_W×VIEW_H,白底居中) → ARGB 像素行主序。整屏/局部共用此中间态。 */
    private fun buildViewPixels(shot: Bitmap): IntArray {
        val sc = minOf(VIEW_W.toFloat() / shot.width, VIEW_H.toFloat() / shot.height)
        val dw = (shot.width * sc).toInt().coerceIn(1, VIEW_W)
        val dh = (shot.height * sc).toInt().coerceIn(1, VIEW_H)
        val scaled = Bitmap.createScaledBitmap(shot, dw, dh, true)
        val view = Bitmap.createBitmap(VIEW_W, VIEW_H, Bitmap.Config.ARGB_8888)
        Canvas(view).apply { drawColor(Color.WHITE); drawBitmap(scaled, ((VIEW_W - dw) / 2).toFloat(), ((VIEW_H - dh) / 2).toFloat(), null) }
        if (scaled !== shot) scaled.recycle()
        val vpx = IntArray(VIEW_W * VIEW_H)
        view.getPixels(vpx, 0, VIEW_W, 0, 0, VIEW_W, VIEW_H)
        view.recycle()
        return vpx
    }

    /**
     * 竖向视图像素 → IT8951 帧缓冲子矩形(fbX,fbY,fbW,fbH) 的 8bpp 灰度，行主序、行宽=fbW。
     *
     * 朝向：面板竖向安装+原生横向帧缓冲，观看变换=反对角线反转置(TRANSVERSE，自逆)，对内容施同样变换即抵消、得正立不镜像。
     * 映射 FB(x,y)=view(row=VIEW_H-1-x, col=VIEW_W-1-y)。整屏=(0,0,EINK_W,EINK_H)；局部传子矩形即可。
     */
    private fun transverseRegion(vpx: IntArray, fbX: Int, fbY: Int, fbW: Int, fbH: Int): ByteArray {
        val gray = ByteArray(fbW * fbH)
        for (yy in 0 until fbH) {
            val col = VIEW_W - 1 - (fbY + yy)          // → view 列
            var dst = yy * fbW
            for (xx in 0 until fbW) {
                val p = vpx[(VIEW_H - 1 - (fbX + xx)) * VIEW_W + col]   // view(row=VIEW_H-1-x, col)
                val r = (p ushr 16) and 0xFF; val g = (p ushr 8) and 0xFF; val b = p and 0xFF
                gray[dst++] = ((r * 77 + g * 150 + b * 29) shr 8).toByte()
            }
        }
        return gray
    }

    /**
     * 视口归一化矩形(该笔 bbox) → IT8951 帧缓冲子矩形。
     * 复刻 buildViewPixels 的 fit + transverseRegion 的转置：宽高互换，加 INK_PAD 余量、x/w 4 对齐、裁进面板。
     */
    private fun inkFbRect(shotW: Int, shotH: Int, nx: Float, ny: Float, nw: Float, nh: Float): IntArray? {
        val sx = nx * shotW; val sy = ny * shotH; val sw = nw * shotW; val sh = nh * shotH
        if (sw <= 0f || sh <= 0f) return null
        // fit（与 buildViewPixels 同）
        val sc = minOf(VIEW_W.toFloat() / shotW, VIEW_H.toFloat() / shotH)
        val offX = (VIEW_W - shotW * sc) / 2f
        val offY = (VIEW_H - shotH * sc) / 2f
        // 脏矩形落到竖向视图坐标
        val vx0 = offX + sx * sc; val vy0 = offY + sy * sc
        val vw = sw * sc; val vh = sh * sc
        // TRANSVERSE：view(col=vx, row=vy) → FB(x=VIEW_H-1-row, y=VIEW_W-1-col)，宽高转置
        var fbX = (VIEW_H - (vy0 + vh)).toInt()
        var fbY = (VIEW_W - (vx0 + vw)).toInt()
        var fbW = vh.toInt()
        var fbH = vw.toInt()
        // 余量
        fbX -= INK_PAD; fbY -= INK_PAD; fbW += 2 * INK_PAD; fbH += 2 * INK_PAD
        // x/w 4 对齐（IT8951 8bpp 安全）
        val ax = fbX and 0x3; fbX -= ax; fbW += ax
        fbW = (fbW + 3) and 0x3.inv()
        // 裁进帧缓冲
        if (fbX < 0) { fbW += fbX; fbX = 0 }
        if (fbY < 0) { fbH += fbY; fbY = 0 }
        if (fbX >= EINK_W || fbY >= EINK_H) return null
        if (fbX + fbW > EINK_W) fbW = EINK_W - fbX
        if (fbY + fbH > EINK_H) fbH = EINK_H - fbY
        if (fbW <= 0 || fbH <= 0) return null
        return intArrayOf(fbX, fbY, fbW, fbH)
    }

    /** 忙时累积局部并集（视口归一化），等当前帧推完由 finishPush 补刷，避免丢笔。 */
    @Synchronized
    private fun stashInk(nx: Float, ny: Float, nw: Float, nh: Float) {
        val p = pendingInk
        pendingInk = if (p == null) floatArrayOf(nx, ny, nw, nh) else {
            val x0 = minOf(p[0], nx); val y0 = minOf(p[1], ny)
            val x1 = maxOf(p[0] + p[2], nx + nw); val y1 = maxOf(p[1] + p[3], ny + nh)
            floatArrayOf(x0, y0, x1 - x0, y1 - y0)
        }
    }

    /** 一帧推完：解忙，若有暂存的局部并集则补刷一帧。 */
    private fun finishPush(webView: WebView) {
        val p: FloatArray?
        synchronized(this) { p = pendingInk; pendingInk = null }
        busy = false
        if (p != null) main.post { mirrorInk(webView, p[0], p[1], p[2], p[3]) }
    }

    /** 帧头 + 灰度写 helper socket（连接复用，断了重连，读回状态阻塞到刷完）。 */
    @Synchronized
    private fun pushFrame(x: Int, y: Int, w: Int, h: Int, mode: Int, gray: ByteArray) {
        val out = ensureSocket() ?: return
        try {
            val hdr = ByteBuffer.allocate(24).order(ByteOrder.LITTLE_ENDIAN)
            hdr.putInt(MAGIC).putInt(x).putInt(y).putInt(w).putInt(h).putInt(mode)
            out.write(hdr.array()); out.write(gray); out.flush()
            sock?.inputStream?.let { ins -> readFull(ins, ByteArray(4)) }   // 等 helper 回 status
        } catch (_: Throwable) { closeSocket() }
    }

    private fun ensureSocket(): OutputStream? {
        sock?.let { if (it.isConnected) return it.outputStream }
        return try {
            val s = LocalSocket()
            s.connect(LocalSocketAddress(SOCK_NAME, LocalSocketAddress.Namespace.ABSTRACT))
            sock = s; s.outputStream
        } catch (_: Throwable) { null }
    }

    private fun closeSocket() { try { sock?.close() } catch (_: Throwable) {}; sock = null }

    private fun readFull(ins: InputStream, buf: ByteArray) {
        var off = 0
        while (off < buf.size) { val r = ins.read(buf, off, buf.size - off); if (r <= 0) break; off += r }
    }
}
