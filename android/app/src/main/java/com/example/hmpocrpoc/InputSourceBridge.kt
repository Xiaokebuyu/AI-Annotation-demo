package com.example.hmpocrpoc

import android.view.MotionEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * M103 设备专用：原生层直接判定"这次触摸到底是哪个物理输入设备、哪种笔尖"。
 *
 * 2026-07-01 真机排查确认：`HqHwBridge` 武装厂商快速手写模式(`sys.is.openhw=1`)后，真实 huion
 * 触控笔在到达 WebView 自己合成 PointerEvent 之前，底层会丢失笔尖/橡皮标识位——WebView 最终报给
 * JS 的 `pointerType` 变成 `"touch"`(压感数据还在，只是身份信息被吞了)。真机对照实验证实"降级"
 * 发生在 WebView 内部的 MotionEvent→PointerEvent 转换这一步，不是 Android 原始 MotionEvent 本身
 * 就丢了信息——挂在 WebView 上的 `OnTouchListener`（在 WebView 内部处理之前先触发）看到的
 * `MotionEvent.getDevice()`/`getToolType()` 仍然准确。
 *
 * 这里就是利用这个时序差：原生先一步拿到没被污染的原始分类（设备名分笔/指，tool type 分笔尖/橡皮），
 * 通过一个同步的 `@JavascriptInterface` 暴露给 JS，让 `ink.ts`/`reader.ts` 在 M103 上把它当权威信号，
 * 不再完全依赖会被厂商快速手写模式弄脏的 `pointerType`/`buttons`。用同步接口（不是 postMessage 那种
 * 异步通道）是为了避免"分类还没到、笔画已经在处理"的时序竞争。
 */
object InputSourceBridge {
    private const val DEVICE_PEN = "huion-ts"
    private const val DEVICE_FINGER = "fts_ts"

    @Volatile private var lastKind: String = "unknown"

    @JvmStatic
    fun attach(webView: WebView) {
        webView.setOnTouchListener { _, event ->
            classify(event)
            false // 不消费事件，只是先看一眼；照常交给 WebView 自己处理
        }
        webView.addJavascriptInterface(JsBridge(), "InkLoopInputSource")
    }

    private fun classify(event: MotionEvent) {
        val name = event.device?.name ?: ""
        lastKind = when {
            name == DEVICE_PEN && event.getToolType(0) == MotionEvent.TOOL_TYPE_ERASER -> "eraser"
            name == DEVICE_PEN -> "pen"
            name == DEVICE_FINGER -> "touch"
            else -> "unknown"
        }
    }

    private class JsBridge {
        @JavascriptInterface
        fun classifyLast(): String = lastKind

        /** OSD 快速墨迹是不是真的武装成功——前端据此决定这一笔要不要信任 OSD 做实时视觉、
         *  自己只在抬笔时补画一次，避免两套渲染叠加显得更卡。 */
        @JavascriptInterface
        fun isOsdArmed(): Boolean = HqHwBridge.isArmed()
    }
}
