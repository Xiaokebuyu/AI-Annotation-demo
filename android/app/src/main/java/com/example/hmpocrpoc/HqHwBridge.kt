package com.example.hmpocrpoc

import android.content.Context
import android.graphics.Rect
import android.net.LocalSocket
import android.net.LocalSocketAddress
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import android.os.Process
import android.util.Log
import android.view.Surface
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * HqHwBridge —— 接厂商 `haoqingdrawserver` 的私有快速墨迹叠加层(`hq.hw` raw Binder 服务)。
 *
 * 2026-07-01：用户真机 A/B 对比出厂商自带 `hqreader`(system UID 1000) 手写"非常丝滑"，InkLoop
 * (WebView 画布落笔，走 `RkEinkBridge` 管的 `sys.eink.mode` 主内容层)明显更卡。排查确认 `hq.hw`
 * **不是 UID 门禁**(root/shell UID 都能调只读 transaction，二进制里没有权限检查代码)，是"武装开关"
 * 没人在 InkLoop 前台时去开——hqreader 切到后台会主动 `drawDisable`。
 *
 * `haoqingdrawserver` 自己直接读 `/dev/input/event3` 生成 OSD 快速墨迹（不是被动等 app 喂点）。
 * `/tmp/hqunifiedsocket` 是反方向的——`system_server` 里的 `NoteSocketService` 把 native 笔事件
 * 广播给客户端订阅，不是 app 写坐标给 drawserver 的输入通道；这条链路上不需要碰它。
 *
 * 反编译 hqreader 真实代码(不是黑盒猜测)确认的握手序列(`HqSpeedNote`/`HwDetector.initHwState`)：
 * `attachApplication`(666，只写一个 strongBinder 回调、无 interface token/无 reply，回调不是 AIDL、
 * `MainDrawView$ApplicationThread` 只在非 0 code 时读一个 int 打日志)→配置笔参数(2003/2006/2007/
 * 2008/2009/2010/2011)→`drawEnable`(4001，读 int reply)→`drawUnlock`(4006)→
 * `forbidDrawBeginFromOuter`(4003)→`addDrawArea`(7002，index/left/top/right/bottom，index 用
 * `detectDrawableArea`(7008)动态取空闲槽位，不能像早期版本那样写死；坐标必须是 EBC 面板原生坐标，
 * 不是 Android 逻辑屏幕坐标——面板物理朝向跟 app 逻辑朝向不一致，要经 `nativeDrawRect()` 转一次）。
 * `drawDisable`=4000。
 *
 * 画区来源：**前端主动上报当前可见的墨迹画布矩形**（`window.InkLoopHqHwArea`，见
 * `src/capture/m103-hqhw-area.ts`），不是整个 WebView——早期版本拿整个 WebView 当画区，武装后
 * 厂商 OSD 叠加层会在整个屏幕范围响应笔迹，真机观察到"笔尖被当成橡皮擦、甚至擦掉 UI"，原生代码
 * 看不到 WebView 内部 DOM，没法自己知道"现在画布在哪"，所以改成前端上报。收到空/无效矩形时整个
 * 解除武装（没有可写画布时不应该让 OSD 在任何地方响应笔迹）。
 *
 * ⚠️ 另一个真机确认的限制：武装后真实笔在到达 WebView 自己合成 PointerEvent 之前，会在底层丢失
 * 笔尖标识位，`pointerType` 会被错报成 `touch`（压感数据还在）。这不是这个文件能修的，前端那边
 * 用 `InputSourceBridge`(`window.InkLoopInputSource`) 走另一条更早的原生 `OnTouchListener` 拿到
 * 没被污染的分类做兜底——见 `src/capture/m103-input-source.ts`。
 */
object HqHwBridge {
    private const val TAG = "HqHwBridge"
    private const val SERVICE_NAME = "hq.hw"
    private const val JS_OBJECT = "InkLoopHqHwArea"
    private const val JS_CLEAR_OBJECT = "InkLoopHqHw" // JS→native 同步通道：抬笔交接时清 OSD
    private val ALLOWED_ORIGINS = setOf("https://appassets.androidplatform.net")

    private const val CODE_ATTACH_APPLICATION = 666
    private const val CODE_DRAW_DISABLE = 4000
    private const val CODE_DRAW_ENABLE = 4001
    private const val CODE_FORBID_DRAW_BEGIN_FROM_OUTER = 4003
    private const val CODE_DRAW_LOCK = 4005
    private const val CODE_DRAW_UNLOCK = 4006
    private const val CODE_CLEAR_ALL = 2005
    private const val CODE_ADD_DRAW_AREA = 7002
    private const val CODE_REMOVE_DRAW_AREA = 7003
    private const val CODE_CLEAR_INDEX = 7006 // 只清某画区 index 的 OSD 墨迹（比全清 2005 精准，抬笔交接用）
    private const val CODE_DETECT_DRAWABLE_AREA = 7008
    private const val CODE_OPEN_SOCKET_EVENTS = 4020 // 打开/关闭 drawserver→app 的 native 笔点广播

    // 硬件笔点 socket：drawserver 直接读 /dev/input/event3 生成的 native 笔点，经 system_server 的
    // NoteSocketService 广播到这个 ABSTRACT namespace LocalSocket。我们订阅它、按 action 缓冲整笔，
    // 抬笔一次性交给前端，让持久 canvas 用和 OSD 完全同源的点画笔——消除"写完重刷一遍"的微重影。
    private const val UNIFIED_SOCKET = "/tmp/hqunifiedsocket"
    private const val A_DOWN = 0
    private const val A_UP = 1
    private const val A_MOVE = 2
    private const val A_CANCEL = 3
    private const val A_SOCKET_END = -1
    private const val TOOL_STYLUS = 320 // flag：320=笔尖，321=笔背/橡皮；只把笔尖点喂给持久层

    private const val CODE_PEN_SIZE = 2003
    private const val CODE_SET_ERASE_SIZE = 2004 // 橡皮尺寸/2（原生 eraseSize=32 → 发 16）
    private const val CODE_PEN_STYLE = 2006      // 第一个参数即 drawserver 的 PENFUNCTION：2=PEN(出墨)/0=BALL(不出墨)
    private const val CODE_PEN_COLOR = 2007
    private const val CODE_PEN_POINT_KIND = 2008 // (pointKind, size)：1=line(写字)/2=circle/3=dashed
    private const val CODE_OPEN_TAIL_ERASE = 2009
    private const val CODE_OPEN_NIB_ERASE = 2010
    private const val CODE_PEN_TAIL_COLOR = 2011 // (part, color)：part 321=tail/橡皮端；擦白用 255

    private const val DRAW_AREA_SLOTS = 20
    private const val PEN_BLACK = 0
    private const val PEN_SIZE_DEFAULT = 3       // 原生笔尖默认宽 3
    private const val PEN_POINT_LINE = 1         // 写字点型=line（不是 circle=2）
    private const val PEN_STYLE_PEN = 2          // 笔尖出墨：2006 发 2 → drawserver PENFUNCTION 2
    private const val ERASE_SIZE_HALF = 16       // 2004 参数 = eraseSize(32)/2
    private const val PEN_TAIL_ERASE_COLOR = 255 // tail/橡皮端擦白（不是深灰 30）

    @Volatile private var cached: IBinder? = null
    @Volatile private var webViewRef: WeakReference<WebView>? = null
    @Volatile private var armed = false
    @Volatile private var hasFocus = false
    @Volatile private var activeAreaIndex = -1
    @Volatile private var reportedRect: Rect? = null // 物理屏 px(前端已乘 devicePixelRatio)，画布相对 WebView 视口
    private val callback = HqCallback()
    private val lastNativeArea = Rect()

    // 硬件笔点 socket 状态
    @Volatile private var reportedDpr = 0f // 前端上报的 devicePixelRatio，保证 native↔CSS 换算和 JS 一致
    @Volatile private var socketRun = false
    @Volatile private var socketThread: Thread? = null
    @Volatile private var socketClient: LocalSocket? = null
    private var socketSeq = 0L
    private var strokeStartMs = 0L
    private val strokeBuf = ArrayList<JsPt>(512)

    private data class NativePkt(val action: Int, val nativeX: Float, val nativeY: Float, val pressureRaw: Float, val strokeWidth: Float, val flag: Int)
    private data class CssPt(val x: Float, val y: Float)
    private data class JsPt(val x: Float, val y: Float, val pressure: Float, val t: Long, val strokeWidth: Float, val flag: Int)

    @JvmStatic
    fun attach(webView: WebView) {
        webViewRef = WeakReference(webView)
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, JS_OBJECT, ALLOWED_ORIGINS) { view, message, _, _, _ ->
                val rect = parseAreaMessage(message.data)
                view.post { updateReportedArea(rect) }
            }
        }
        // 抬笔清 OSD 的同步通道：前端在把整笔画进 canvas、且经双 rAF 确认已呈现后调 clearFastInk()，
        // 让 OSD 临时墨迹交接给我们自己的持久画布（否则 OSD 那层墨迹不会自行消失，见 m103-input-source.ts）。
        webView.addJavascriptInterface(HqHwJs(), JS_CLEAR_OBJECT)
        webView.post { if (webView.hasWindowFocus()) { hasFocus = true; tryArmFromReported() } }
    }

    /** 清掉当前画区的 OSD 临时墨迹。抬笔、且我方 canvas 已把整笔画好并呈现后调用，完成"预览层→持久层"交接。
     *  优先按 index 精准清(7006)，服务不认该 code 时退回全清(2005,2)。JS 线程调用安全(只发 Binder 事务)。 */
    @JvmStatic
    fun clearFastInk() {
        if (!armed) return
        val index = activeAreaIndex
        if (index < 0) return
        if (!transactBool(CODE_CLEAR_INDEX, index)) transactNoReply(CODE_CLEAR_ALL, 2)
    }

    /** 当前是不是真的武装成功——前端据此决定"信 OSD 做实时视觉、自己只补一次画"还是"自己画"。 */
    @JvmStatic
    fun isArmed(): Boolean = armed

    @JvmStatic
    fun onResume() {
        hasFocus = true
        webViewRef?.get()?.post { tryArmFromReported() }
    }

    @JvmStatic
    fun onWindowFocusChanged(has: Boolean) {
        hasFocus = has
        if (has) webViewRef?.get()?.post { tryArmFromReported() } else disarm()
    }

    @JvmStatic
    fun onPause() {
        hasFocus = false
        disarm()
    }

    @JvmStatic
    fun destroy() {
        disarm()
        webViewRef = null
    }

    private fun parseAreaMessage(data: String?): Rect? {
        if (data.isNullOrEmpty() || data == "null") return null
        return try {
            val o = JSONObject(data)
            val x = o.getDouble("x"); val y = o.getDouble("y")
            val w = o.getDouble("w"); val h = o.getDouble("h")
            reportedDpr = o.optDouble("dpr", 0.0).toFloat().takeIf { it > 0f } ?: reportedDpr // 和 JS devicePixelRatio 对齐
            if (w <= 0 || h <= 0) null else Rect(x.toInt(), y.toInt(), (x + w).toInt(), (y + h).toInt())
        } catch (_: Throwable) { null }
    }

    @Synchronized
    private fun updateReportedArea(rect: Rect?) {
        reportedRect = rect
        if (!hasFocus) return
        if (rect == null || rect.isEmpty) { disarm(); return }
        val view = webViewRef?.get() ?: return
        if (!armed) { arm(view, rect); return }
        // 已经武装：只挪画区，不重新走一遍握手（避免频繁 drawEnable/drawDisable）。
        val native = nativeDrawRect(view, viewportRectToScreen(view, rect))
        if (native != lastNativeArea) {
            val index = activeAreaIndex
            if (index >= 0) {
                transactNoReply(CODE_ADD_DRAW_AREA, index, native.left, native.top, native.right, native.bottom)
                lastNativeArea.set(native)
            }
        }
    }

    private fun tryArmFromReported() {
        val view = webViewRef?.get() ?: return
        val rect = reportedRect
        if (!armed && rect != null && !rect.isEmpty) arm(view, rect)
    }

    /** 前端上报的矩形已是物理屏 px(乘过 devicePixelRatio)、相对 WebView 视口；加上 WebView 在屏幕上的
     *  物理偏移，转成整屏 Android 物理坐标。两侧同为物理 px，nativeDrawRect 才能对齐 drawserver。 */
    private fun viewportRectToScreen(view: View, viewportRect: Rect): Rect {
        val xy = IntArray(2)
        view.getLocationOnScreen(xy)
        return Rect(
            xy[0] + viewportRect.left, xy[1] + viewportRect.top,
            xy[0] + viewportRect.right, xy[1] + viewportRect.bottom,
        )
    }

    @Synchronized
    private fun arm(view: View, viewportRect: Rect) {
        if (!view.isAttachedToWindow || view.width <= 0 || view.height <= 0) return
        val screenArea = viewportRectToScreen(view, viewportRect)
        if (screenArea.isEmpty) return

        val b = service() ?: return
        try {
            val nativeArea = nativeDrawRect(view, screenArea)
            clearStaleDrawAreas() // 清掉 force-stop 漏下的旧画区(drawserver 跨进程持久残留)，避免多区重复刷/错位
            val index = detectFreeDrawArea()

            attachApplication(b, callback)
            configureDefaultPen()

            val ret = transactIntReply(CODE_DRAW_ENABLE)
            transactNoReply(CODE_DRAW_UNLOCK)
            transactNoReply(CODE_FORBID_DRAW_BEGIN_FROM_OUTER)
            addDrawArea(index, nativeArea)

            // 普通 app UID 大概率写不进去，纯 best-effort，失败不影响其余握手。
            setSystemProperty("sys.hw.process", Process.myPid().toString())

            armed = true
            activeAreaIndex = index
            lastNativeArea.set(nativeArea)
            Log.i(TAG, "armed index=$index viewportRect=$viewportRect nativeArea=$nativeArea drawEnableReply=$ret")
            // 开 native 笔点广播 + 起 socket 读取线程：抬笔时用同源硬件点补画，消除微重影。
            setSocketEventsEnabled(true)
            startUnifiedSocketReader()
        } catch (t: Throwable) {
            cached = null
            armed = false
            Log.w(TAG, "arm failed: ${t.javaClass.simpleName}: ${t.message}")
        }
    }

    @Synchronized
    private fun disarm() {
        if (!armed && cached == null) return
        stopUnifiedSocketReader()
        setSocketEventsEnabled(false)
        try {
            val index = activeAreaIndex
            if (index >= 0) transactNoReply(CODE_REMOVE_DRAW_AREA, index)
            transactNoReply(CODE_CLEAR_ALL, 2)
            transactNoReply(CODE_DRAW_LOCK)
            transactNoReply(CODE_DRAW_DISABLE)
        } catch (t: Throwable) {
            Log.w(TAG, "disarm failed: ${t.javaClass.simpleName}: ${t.message}")
        } finally {
            armed = false
            activeAreaIndex = -1
            lastNativeArea.setEmpty()
        }
    }

    /** 笔配置：1:1 对齐原生 HwDetector.applyHwConfig() 的默认笔（笔尖出黑墨、笔背擦白）。顺序照原生
     *  baseline 实抓的 2007→2003→2004→2008→2006→2009→2011。关键三点(早期错配就是笔尖写不上/橡皮不消失的根因)：
     *  ① 2006 第一参 = PENFUNCTION，必须 2(PEN) 否则笔尖不出墨(旧值 0=BALL)；② 2008 用 1(line) 写字点型
     *  (旧值 2=circle)；③ 2011 tail 色 255(白=擦除)，旧值 30(深灰)会画出不消失的深色轨迹。 */
    private fun configureDefaultPen() {
        transactNoReply(CODE_PEN_COLOR, PEN_BLACK)                              // 2007: 0    笔尖黑
        transactNoReply(CODE_PEN_SIZE, PEN_SIZE_DEFAULT)                        // 2003: 3    笔宽
        transactNoReply(CODE_SET_ERASE_SIZE, ERASE_SIZE_HALF)                   // 2004: 16   橡皮尺寸/2
        transactNoReply(CODE_PEN_POINT_KIND, PEN_POINT_LINE, PEN_SIZE_DEFAULT)  // 2008: 1,3  line 写字点型
        transactNoReply(CODE_PEN_STYLE, PEN_STYLE_PEN)                          // 2006: 2    → PENFUNCTION 2 笔尖出墨
        transactNoReply(CODE_OPEN_NIB_ERASE, 0)                                 // 2010: 0    笔尖不是橡皮(防残留态)
        transactNoReply(CODE_OPEN_TAIL_ERASE, 1)                                // 2009: 1    开笔背橡皮
        transactNoReply(CODE_PEN_TAIL_COLOR, 321, PEN_TAIL_ERASE_COLOR)         // 2011: 321,255 笔背擦白
    }

    private fun addDrawArea(index: Int, rect: Rect) {
        transactNoReply(CODE_ADD_DRAW_AREA, index, rect.left, rect.top, rect.right, rect.bottom)
    }

    /** 清掉 drawserver 里所有已注册画区。force-stop 杀进程时来不及 disarm，旧画区会跨进程持久残留在
     *  drawserver(独立守护进程)里——真机 logcat 实锤同时挂着旧错误区+退化区+新区，逐点要和三块一起比、
     *  重复刷/错位。武装前先清干净。只在 InkLoop 前台时调用是安全的：此刻没有别的 app 需要 OSD 画区
     *  (原生 reader 切后台会自己 drawDisable、回前台会自己 initHwState 重新加回)。 */
    private fun clearStaleDrawAreas() {
        val b = service() ?: return
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        try {
            data.writeInt(DRAW_AREA_SLOTS)
            if (!b.transact(CODE_DETECT_DRAWABLE_AREA, data, reply, 0)) return
            val used = IntArray(DRAW_AREA_SLOTS)
            reply.readIntArray(used)
            for (i in used.indices) if (used[i] != 0) transactNoReply(CODE_REMOVE_DRAW_AREA, i)
        } catch (_: Throwable) {
        } finally {
            reply.recycle()
            data.recycle()
        }
    }

    /** 找一个空闲画区槽位(厂商自己也是动态取，写死的槽位号可能已被占用而静默失败)。查不到就退回 1。 */
    private fun detectFreeDrawArea(): Int {
        val b = service() ?: return 1
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInt(DRAW_AREA_SLOTS)
            if (!b.transact(CODE_DETECT_DRAWABLE_AREA, data, reply, 0)) return 1
            val used = IntArray(DRAW_AREA_SLOTS)
            reply.readIntArray(used)
            used.indexOfFirst { it == 0 }.takeIf { it >= 0 } ?: 1
        } catch (_: Throwable) {
            1
        } finally {
            reply.recycle()
            data.recycle()
        }
    }

    /** Android 屏幕坐标 → EBC 面板原生坐标：面板物理朝向跟 app 逻辑朝向不一致，按当前旋转转一次。
     *  这是早期版本"握手不报错、画区却始终不命中"的根因——坐标系传错了。 */
    private fun nativeDrawRect(view: View, rect: Rect): Rect {
        val dm = view.context.resources.displayMetrics
        val wm = view.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val w = dm.widthPixels
        val h = dm.heightPixels
        @Suppress("DEPRECATION")
        val rotation = wm.defaultDisplay.rotation
        val out = when (rotation) {
            Surface.ROTATION_90 -> Rect(rect.left, rect.top, rect.right, rect.bottom)
            Surface.ROTATION_180 -> Rect(h - rect.bottom, rect.left, h - rect.top, rect.right)
            Surface.ROTATION_270 -> Rect(w - rect.left, h - rect.top, w - rect.right, h - rect.bottom)
            else -> Rect(rect.top, w - rect.right, rect.bottom, w - rect.left) // ROTATION_0
        }
        out.sort()
        return out
    }

    // ---- 硬件笔点 socket：订阅 native 笔点、按 action 缓冲整笔、抬笔交付前端 ----

    /** 4020：打开/关闭 drawserver→app 的 native 笔点广播。武装成功后开、disarm 时关。 */
    private fun setSocketEventsEnabled(enable: Boolean): Boolean {
        val b = service() ?: return false
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            data.writeInt(if (enable) 1 else 0)
            if (!b.transact(CODE_OPEN_SOCKET_EVENTS, data, reply, 0)) return false
            reply.readInt() == 1
        } catch (t: Throwable) {
            Log.w(TAG, "4020(${if (enable) 1 else 0}) failed: ${t.javaClass.simpleName}: ${t.message}")
            false
        } finally {
            reply.recycle()
            data.recycle()
        }
    }

    @Synchronized
    private fun startUnifiedSocketReader() {
        if (socketRun) return
        socketRun = true
        socketThread = kotlin.concurrent.thread(name = "InkLoop-HqUnifiedSocket", isDaemon = true) {
            val buf = ByteArray(40)
            while (socketRun) {
                try {
                    val s = LocalSocket()
                    socketClient = s
                    s.connect(LocalSocketAddress(UNIFIED_SOCKET, LocalSocketAddress.Namespace.ABSTRACT))
                    val input = s.inputStream
                    while (socketRun && readFully40(input, buf)) handleSocketPacket(buf)
                } catch (t: Throwable) {
                    if (socketRun) Log.w(TAG, "unified socket loop: ${t.javaClass.simpleName}: ${t.message}")
                } finally {
                    try { socketClient?.close() } catch (_: Throwable) {}
                    socketClient = null
                    resetSocketStroke()
                }
                if (socketRun) try { Thread.sleep(500) } catch (_: InterruptedException) {}
            }
        }
    }

    @Synchronized
    private fun stopUnifiedSocketReader() {
        socketRun = false
        try { socketClient?.shutdownInput() } catch (_: Throwable) {}
        try { socketClient?.close() } catch (_: Throwable) {}
        socketClient = null
        socketThread?.interrupt()
        socketThread = null
        resetSocketStroke()
    }

    private fun readFully40(input: java.io.InputStream, out: ByteArray): Boolean {
        var off = 0
        while (off < 40) {
            val n = input.read(out, off, 40 - off)
            if (n < 0) return false
            off += n
        }
        return true
    }

    private fun parsePacket(b: ByteArray): NativePkt {
        val bb = java.nio.ByteBuffer.wrap(b).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        // ⚠️真机标定实锤(2026-07-01)：float[0]=nativeX(=screenY)、float[1]=nativeY(=w-screenX)——
        // codex 原说的 float[0]=nativeY/float[1]=nativeX 是反的，照它取会让笔迹整体缩向左上。
        val nativeX = bb.getFloat(0)      // float[0]
        val nativeY = bb.getFloat(4)      // float[1]
        val pressure = bb.getFloat(8)     // float[2]
        val action = bb.getInt(20)        // int@20
        val strokeWidth = bb.getFloat(24) // float[6]
        val flag = bb.getInt(28)          // int@28
        return NativePkt(action, nativeX, nativeY, pressure, strokeWidth, flag)
    }

    private fun handleSocketPacket(bytes: ByteArray) {
        val p = parsePacket(bytes)
        if (p.action == A_SOCKET_END) {
            try { socketClient?.close() } catch (_: Throwable) {}
            return
        }
        if (p.flag != TOOL_STYLUS) { // 非笔尖(橡皮/手指)不喂持久层——橡皮走 WebView eraseAt
            if (p.action == A_UP || p.action == A_CANCEL) resetSocketStroke()
            return
        }
        val css = nativeToCssViewport(p) ?: return
        if (!pointInReportedArea(css)) { // 出画区：把已缓冲的这一笔收尾交付，之后的点丢弃
            if (strokeBuf.isNotEmpty()) finishSocketStroke()
            return
        }
        val now = android.os.SystemClock.uptimeMillis()
        when (p.action) {
            A_DOWN -> { resetSocketStroke(); strokeStartMs = now; appendSocketPoint(p, css, now) }
            A_MOVE -> { if (strokeBuf.isEmpty()) strokeStartMs = now; appendSocketPoint(p, css, now) }
            A_UP -> { if (strokeBuf.isEmpty()) strokeStartMs = now; appendSocketPoint(p, css, now); finishSocketStroke() }
            A_CANCEL -> resetSocketStroke()
        }
    }

    private fun appendSocketPoint(p: NativePkt, css: CssPt, now: Long) {
        strokeBuf.add(JsPt(css.x, css.y, normalizePressure(p.pressureRaw), now - strokeStartMs, p.strokeWidth, p.flag))
    }

    /** 一整笔(down..up)缓冲完，转 JSON 一次性推给前端 `window.__inkLoopOnHqSocketStroke`。 */
    private fun finishSocketStroke() {
        if (strokeBuf.isEmpty()) return
        val pts = ArrayList(strokeBuf)
        resetSocketStroke()
        val arr = org.json.JSONArray()
        for (pt in pts) {
            arr.put(org.json.JSONObject()
                .put("x", pt.x.toDouble()).put("y", pt.y.toDouble())
                .put("pressure", pt.pressure.toDouble()).put("t", pt.t)
                .put("strokeWidth", pt.strokeWidth.toDouble()).put("flag", pt.flag))
        }
        val payload = org.json.JSONObject().put("seq", ++socketSeq).put("source", "hqunifiedsocket").put("points", arr)
        val view = webViewRef?.get() ?: return
        view.post {
            view.evaluateJavascript("window.__inkLoopOnHqSocketStroke&&window.__inkLoopOnHqSocketStroke($payload);", null)
        }
    }

    private fun resetSocketStroke() { strokeBuf.clear(); strokeStartMs = 0L }

    private fun normalizePressure(v: Float): Float {
        if (v.isNaN() || v.isInfinite()) return 0f
        return if (v > 1.5f) (v / 4096f).coerceIn(0f, 1f) else v.coerceIn(0f, 1f)
    }

    private fun currentDpr(view: View): Float {
        val d = reportedDpr
        return if (d > 0f) d else view.context.resources.displayMetrics.density
    }

    /** native 面板坐标 → WebView CSS 视口坐标（严格反 nativeDrawRect 的 ROTATION_0 变换，再 ÷dpr）。 */
    private fun nativeToCssViewport(p: NativePkt): CssPt? {
        val view = webViewRef?.get() ?: return null
        @Suppress("DEPRECATION")
        val rotation = (view.context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation
        if (rotation != Surface.ROTATION_0) return null // 当前路径只承诺 ROTATION_0
        val screenW = view.context.resources.displayMetrics.widthPixels.toFloat()
        val xy = IntArray(2)
        view.getLocationOnScreen(xy)
        val sx = screenW - p.nativeY
        val sy = p.nativeX
        val dpr = currentDpr(view)
        return CssPt(x = (sx - xy[0]) / dpr, y = (sy - xy[1]) / dpr)
    }

    private fun pointInReportedArea(css: CssPt): Boolean {
        val view = webViewRef?.get() ?: return false
        val r = reportedRect ?: return false // 物理 px，相对 WebView viewport
        val dpr = currentDpr(view)
        val px = css.x * dpr
        val py = css.y * dpr
        val pad = 3f * dpr
        return px >= r.left - pad && px <= r.right + pad && py >= r.top - pad && py <= r.bottom + pad
    }

    private fun attachApplication(b: IBinder, cb: IBinder): Boolean {
        val data = Parcel.obtain()
        return try {
            data.writeStrongBinder(cb)
            b.transact(CODE_ATTACH_APPLICATION, data, null, 0)
        } finally {
            data.recycle()
        }
    }

    private fun transactNoReply(code: Int, vararg ints: Int): Boolean {
        val b = service() ?: return false
        val data = Parcel.obtain()
        return try {
            ints.forEach { data.writeInt(it) }
            b.transact(code, data, null, 0)
        } catch (t: Throwable) {
            cached = null
            Log.w(TAG, "transact($code) failed: ${t.javaClass.simpleName}: ${t.message}")
            false
        } finally {
            data.recycle()
        }
    }

    /** 发一个 no-reply 事务、返回是否成功；用于"优先 7006、不认就退回 2005"这种要看返回值的场景
     *  (transactNoReply 会在失败时把 cached 置空并告警，不适合当"探测服务认不认某 code")。 */
    private fun transactBool(code: Int, vararg ints: Int): Boolean {
        val b = service() ?: return false
        val data = Parcel.obtain()
        return try {
            ints.forEach { data.writeInt(it) }
            b.transact(code, data, null, 0)
        } catch (_: Throwable) {
            false
        } finally {
            data.recycle()
        }
    }

    private fun transactIntReply(code: Int): Int {
        val b = service() ?: return -1
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        return try {
            b.transact(code, data, reply, 0)
            reply.readInt()
        } catch (t: Throwable) {
            cached = null
            Log.w(TAG, "transactReply($code) failed: ${t.javaClass.simpleName}: ${t.message}")
            -1
        } finally {
            reply.recycle()
            data.recycle()
        }
    }

    @Suppress("PrivateApi")
    private fun service(): IBinder? {
        cached?.let { if (it.isBinderAlive) return it }
        return try {
            val cls = Class.forName("android.os.ServiceManager")
            val m = cls.getDeclaredMethod("getService", String::class.java)
            (m.invoke(null, SERVICE_NAME) as? IBinder)?.also { b ->
                cached = b
                try {
                    b.linkToDeath({
                        cached = null
                        armed = false
                    }, 0)
                } catch (_: Throwable) {}
            }
        } catch (_: Throwable) {
            null
        }
    }

    @Suppress("PrivateApi")
    private fun setSystemProperty(key: String, value: String) {
        try {
            Class.forName("android.os.SystemProperties")
                .getMethod("set", String::class.java, String::class.java)
                .invoke(null, key, value)
        } catch (_: Throwable) {}
    }

    /** JS→native 同步桥：前端抬笔交接时调 clearFastInk() 清 OSD。运行在 WebView 的 JavaBridge 线程，
     *  只发 Binder 事务、读 @Volatile 状态，线程安全。 */
    private class HqHwJs {
        @JavascriptInterface
        fun clearFastInk() { HqHwBridge.clearFastInk() }
    }

    /** 厂商回调不是 AIDL：非 0 code 时读一个 int 打日志即可，照抄 `MainDrawView$ApplicationThread` 行为。 */
    private class HqCallback : Binder() {
        override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
            if (code != 0) {
                try {
                    val v = if (data.dataAvail() >= 4) data.readInt() else Int.MIN_VALUE
                    Log.d(TAG, "callback code=$code value=$v flags=$flags")
                } catch (_: Throwable) {}
            }
            return true
        }
    }
}
