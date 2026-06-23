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
 * Phase 2 文件——不在 Phase 1 编译。启用端侧 OCR 时，连同 POC 源码一起移入
 *   android/app/src/main/java/com/example/hmpocrpoc/
 * 并加依赖、在 MainActivity 取消 OcrBridge.attach 注释（见 INTEGRATION.md「Phase 2」）。
 *
 * JS↔原生桥：把 InkLoop 前端的端侧 RPC（window.InkLoopOcr）接到 POC 的 OCR / intent 能力。
 * 前端契约见 src/evidence/ondevice.ts：
 *   REQ  {"id","method","args"}   method ∈ recognizeInk | ocrRegion | classifyIntent | capabilities
 *   RES  {"id","ok":true,"result":{...}}  或  {"id","ok":false,"error":"..."}
 *
 * 放在 com.example.hmpocrpoc 包，以便直接访问 IntentClassifier / HandwritingReranker /
 * EnglishDictionary 的包级私有成员——POC 源码原样拷入本包即可，无需改可见性。
 *
 * v1 识别走 PP-OCR（栅格，zh+en，无需 GMS）；ML Kit Digital Ink 手写增强见文末说明（可选，需 GMS）。
 */
object OcrBridge {

    private const val JS_OBJECT = "InkLoopOcr"
    private val ALLOWED_ORIGINS = setOf("https://appassets.androidplatform.net")

    @Volatile private var dict: EnglishDictionary? = null

    /** 在 WebView 上注册 window.InkLoopOcr 通道。MainActivity 在加载页面前调用。 */
    @JvmStatic
    fun attach(webView: WebView, context: Context) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return
        val appCtx = context.applicationContext
        loadDictAsync(appCtx)
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
                "capabilities" -> ok(reply, id, JSONObject().put("gms", hasGms(ctx)))

                "classifyIntent" -> {
                    val intent = IntentClassifier.classify(args.optString("action"), args.optString("text"))
                    ok(reply, id, JSONObject().put("intent", intent))
                }

                "ocrRegion" -> {
                    val bmp = decode(args.optString("imagePng")) ?: return fail(reply, id, "bad image")
                    PpOcrBridge.recognize(ctx, bmp, object : PpOcrBridge.Callback {
                        override fun onSuccess(result: PpOcrBridge.PpOcrResult) =
                            ok(reply, id, JSONObject().put("text", result.text.trim()))
                        override fun onFailure(error: String) = fail(reply, id, error)
                    })
                }

                "recognizeInk" -> {
                    val bmp = decode(args.optString("inkPng")) ?: return fail(reply, id, "bad ink image")
                    PpOcrBridge.recognize(ctx, bmp, object : PpOcrBridge.Callback {
                        override fun onSuccess(result: PpOcrBridge.PpOcrResult) {
                            val text = result.text.trim()
                            val res = JSONObject()
                            if (text.isNotEmpty()) {
                                res.put("kind", "handwriting").put("reading", text).put("description", "")
                            } else {
                                // 无可信文字 → 当作画。端侧无 VLM 描述（前端可保留云端 hybrid 兜底拿描述）。
                                res.put("kind", "sketch").put("reading", "").put("description", "")
                            }
                            ok(reply, id, res)
                        }
                        override fun onFailure(error: String) = fail(reply, id, error)
                    })
                }

                else -> fail(reply, id, "unknown method: $method")
            }
        } catch (t: Throwable) {
            fail(reply, id, t.message ?: t.toString())
        }
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

    /** GMS 是否可用（反射调用，未加 play-services-base 依赖时安全返回 false）。 */
    private fun hasGms(ctx: Context): Boolean = try {
        val cls = Class.forName("com.google.android.gms.common.GoogleApiAvailability")
        val inst = cls.getMethod("getInstance").invoke(null)
        val code = cls.getMethod("isGooglePlayServicesAvailable", Context::class.java).invoke(inst, ctx) as Int
        code == 0 // ConnectionResult.SUCCESS
    } catch (_: Throwable) { false }

    private fun loadDictAsync(ctx: Context) {
        if (dict != null) return
        Thread {
            try { dict = EnglishDictionary.fromInputStream(ctx.assets.open("dictionaries/en_us_words.txt")) }
            catch (_: Throwable) { /* 词典可选，缺失不影响 PP-OCR */ }
        }.start()
    }

    /*
     * ── 可选：ML Kit Digital Ink 手写增强（需 GMS + play-services-mlkit-digitalink-recognition）──
     * recognizeInk 命中手写且 hasGms() 时，可用笔迹点序替代 PP-OCR 栅格（笔顺动态对手写更准）：
     *
     *   1) 从 args.optJSONArray("strokes") 取 StrokePoint{x,y,t,pressure}（归一化坐标），
     *      乘一个画布尺度（如 1000f）重建 ML Kit Ink：
     *        Ink.builder() → 每笔 Ink.Stroke.builder() → addPoint(Ink.Point.create(x*S, y*S, t)) → build()
     *      （前端 stroke_points 目前是单事件扁平点序，多笔边界可能丢；ML Kit 多笔更准，
     *        必要时让前端按 stroke 分组后传 strokes:[[...],[...]]。）
     *   2) DigitalInkBridge.recognize(ink, langTag, w, h, preContext="", cb) 取候选；
     *      langTag 需按内容语种选（zh-Hans / en-US…），多语种先判语种。
     *   3) HandwritingReranker.rerank(candidates, "", "", langTag, dict ?: EnglishDictionary.empty())
     *      → result.selectedText 作为 reading，kind="handwriting"。
     */
}
