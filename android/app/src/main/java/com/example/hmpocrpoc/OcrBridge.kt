package com.example.hmpocrpoc

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * JS↔原生桥：把 InkLoop 前端的端侧 RPC（window.InkLoopOcr）接到端侧 OCR 能力。
 * 前端契约见 src/evidence/ondevice.ts：
 *   REQ  {"id","method","args"}   method ∈ ocrRegion | recognizeInk | classifyIntent | capabilities
 *   RES  {"id","ok":true,"result":{...}}  或  {"id","ok":false,"error":"..."}
 *
 * 端侧职责（2026-06-24 对齐徐架构后定，见记忆 inkloop-android-wrapper-branch『分类器端侧平替映射』）：
 *   · ocrRegion    —— 印刷/规整文字区域 OCR：ML Kit text（Latin+中文，bundled 离线、不绑 GMS、~178ms）优先；
 *                     空结果/失败再退 PP-OCRv6 兜底（~435ms）。这是端侧唯一真正承载的活。
 *   · recognizeInk —— 手写「判 kind + 转写 + 画描述」：端侧无可用引擎（Digital Ink 绑 GMS、目标板多半没有；
 *                     栅格读手写实测 exact≈0.5 不可用），一律返回 ok=false → 前端降级云 /api/interpret（VLM 判类型+转写+描述）。
 *                     待商业 raw-stroke HWR SDK 接入后再在此接手写转写（见文末槽位）。
 *   · classifyIntent—— 端侧 intent 规则已在前端 TS（intent-rules.ts）权威执行，这里不重复，返回 ok=false。
 *   · capabilities —— 上报 {ocr:true（印刷 OCR 恒可用）, gms:<是否有 Play 服务，决定将来 Digital Ink 能否兜手写>}。
 *
 * 包名沿用徐的 com.example.hmpocrpoc，与 MlKitTextOcrBridge / PpOcrBridge 同包，便于日后从徐工程同步更新。
 */
object OcrBridge {

    private const val JS_OBJECT = "InkLoopOcr"
    private val ALLOWED_ORIGINS = setOf("https://appassets.androidplatform.net")

    /** 在 WebView 上注册 window.InkLoopOcr 通道。MainActivity 在 loadUrl 前调用。 */
    @JvmStatic
    fun attach(webView: WebView, context: Context) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val appCtx = context.applicationContext
        WebViewCompat.addWebMessageListener(webView, JS_OBJECT, ALLOWED_ORIGINS) { _, message, _, _, replyProxy ->
            handle(appCtx, message.data ?: "", replyProxy)
        }
    }

    private fun handle(ctx: Context, raw: String, reply: JavaScriptReplyProxy) {
        val req = try { JSONObject(raw) } catch (_: Throwable) { return }
        val id = req.optString("id")
        val method = req.optString("method")
        val args = req.optJSONObject("args") ?: JSONObject()
        try {
            when (method) {
                "capabilities" ->
                    ok(reply, id, JSONObject().put("ocr", true).put("gms", hasGms(ctx)))

                "ocrRegion" -> {
                    val bmp = decode(args.optString("imagePng")) ?: return fail(reply, id, "bad image")
                    ocrRegion(ctx, bmp, id, reply)
                }

                // 手写识别端侧无引擎 → 让前端走云端 /api/interpret（VLM 判 kind+转写+画描述）。
                "recognizeInk" -> fail(reply, id, "ondevice handwriting engine unavailable")

                // intent 规则已在前端 TS（intent-rules.ts）权威执行。
                "classifyIntent" -> fail(reply, id, "intent handled in frontend")

                else -> fail(reply, id, "unknown method: $method")
            }
        } catch (t: Throwable) {
            fail(reply, id, t.message ?: t.toString())
        }
    }

    /** 印刷区域 OCR：ML Kit text 优先；空结果或失败 → PP-OCRv6 兜底。 */
    private fun ocrRegion(ctx: Context, bmp: Bitmap, id: String, reply: JavaScriptReplyProxy) {
        MlKitTextOcrBridge.recognizeLatinChinese("ocrRegion", bmp, object : MlKitTextOcrBridge.Callback {
            override fun onSuccess(result: MlKitTextOcrBridge.MlKitOcrResult) {
                val text = result.text.trim()
                if (text.isNotEmpty()) ok(reply, id, JSONObject().put("text", text))
                else ppFallback(ctx, bmp, id, reply) // ML Kit 没读出 → PP-OCR 再试
            }
            override fun onFailure(error: String) = ppFallback(ctx, bmp, id, reply)
        })
    }

    private fun ppFallback(ctx: Context, bmp: Bitmap, id: String, reply: JavaScriptReplyProxy) {
        PpOcrBridge.recognize(ctx, bmp, object : PpOcrBridge.Callback {
            override fun onSuccess(result: PpOcrBridge.PpOcrResult) =
                ok(reply, id, JSONObject().put("text", result.text.trim()))
            override fun onFailure(error: String) = fail(reply, id, error)
        })
    }

    private fun ok(reply: JavaScriptReplyProxy, id: String, result: JSONObject) {
        reply.postMessage(JSONObject().put("id", id).put("ok", true).put("result", result).toString())
    }

    private fun fail(reply: JavaScriptReplyProxy, id: String, error: String) {
        reply.postMessage(JSONObject().put("id", id).put("ok", false).put("error", error).toString())
    }

    private fun decode(dataUrl: String?): Bitmap? {
        if (dataUrl.isNullOrEmpty()) return null
        val comma = dataUrl.indexOf(',')
        val b64 = if (comma >= 0) dataUrl.substring(comma + 1) else dataUrl
        return try {
            val bytes = Base64.decode(b64, Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        } catch (_: Throwable) { null }
    }

    /** GMS 是否可用（反射，未加 play-services-base 依赖时安全返回 false）。仅用于 capabilities 上报。 */
    private fun hasGms(ctx: Context): Boolean = try {
        val cls = Class.forName("com.google.android.gms.common.GoogleApiAvailability")
        val inst = cls.getMethod("getInstance").invoke(null)
        val code = cls.getMethod("isGooglePlayServicesAvailable", Context::class.java).invoke(inst, ctx) as Int
        code == 0 // ConnectionResult.SUCCESS
    } catch (_: Throwable) { false }

    /*
     * ── 槽位：商业 raw-stroke HWR SDK（手写转写的真引擎）──
     * 拿到汉王/Onyx 厂商 SDK 或 MyScript iink 后，在 recognizeInk 里：
     *   1) 从 args.optJSONArray("strokes") 取笔迹点序（前端归一化 stroke_points，必要时让前端按笔分组）；
     *   2) 调 SDK 的 raw-stroke 识别取候选 + 重排，selectedText 作 reading、kind="handwriting"；
     *   3) ok(reply, id, {kind, reading, description=""})。
     * 在此之前 recognizeInk 恒返回 unavailable，前端走云 /api/interpret，行为正确不阻塞。
     * （注：ML Kit Digital Ink 绑 GMS、目标 RK3588 板多半无 GMS → 不作为这条槽位的默认实现。）
     */
}
