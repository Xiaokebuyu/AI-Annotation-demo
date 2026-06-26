package com.example.hmpocrpoc

import android.content.Context
import android.graphics.Bitmap
import com.paddle.ocr.EngineConfig
import com.paddle.ocr.PaddleOCR
import com.paddle.ocr.PaddleOCRConfig
import com.paddle.ocr.model.OCRRunResult
import com.paddle.ocr.util.OpenCVUtils
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.opencv.core.Core

object PpOcrBridge {
    interface Callback {
        fun onSuccess(result: PpOcrResult)
        fun onFailure(error: String)
    }

    data class PpOcrResult(
        val text: String,
        val lineCount: Int,
        val totalTimeMs: Long,
        val detectionTimeMs: Long,
        val recognitionTimeMs: Long,
        val coldLoadTimeMs: Long,
    )

    private const val DET_MAX_SIDE_LIMIT = 640
    private const val REC_BATCH_SIZE = 4
    private const val ORT_NUM_THREADS = 4
    private const val OPENCV_NUM_THREADS = 2

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private var ocr: PaddleOCR? = null

    @JvmStatic
    fun recognize(context: Context, bitmap: Bitmap, callback: Callback) {
        val appContext = context.applicationContext
        scope.launch {
            try {
                val engine = lock.withLock {
                    val existing = ocr
                    if (existing != null) {
                        existing
                    } else {
                        if (!OpenCVUtils.init(appContext)) {
                            throw IllegalStateException("OpenCV init failed")
                        }
                        Core.setNumThreads(OPENCV_NUM_THREADS)
                        Core.setUseOptimized(true)
                        PaddleOCR.create(
                            context = appContext,
                            config = PaddleOCRConfig(
                                detMaxSideLimit = DET_MAX_SIDE_LIMIT,
                                recBatchSize = REC_BATCH_SIZE,
                            ),
                            engineConfig = EngineConfig(numThreads = ORT_NUM_THREADS),
                            detModelAssetPath = "models/det/inference.onnx",
                            recModelAssetPath = "models/rec/inference.onnx",
                            recConfigAssetPath = "models/rec/inference.yml",
                        ).also { ocr = it }
                    }
                }
                val result = engine.recognize(bitmap)
                withContext(Dispatchers.Main) {
                    callback.onSuccess(result.toBridgeResult())
                }
            } catch (t: Throwable) {
                val error = t.stackTraceToString()
                withContext(Dispatchers.Main) {
                    callback.onFailure(error)
                }
            }
        }
    }

    private fun OCRRunResult.toBridgeResult(): PpOcrResult {
        val text = results.joinToString("\n") { it.text }
        return PpOcrResult(
            text = text,
            lineCount = lineCount,
            totalTimeMs = totalTimeMs,
            detectionTimeMs = detectionTimeMs,
            recognitionTimeMs = recognitionTimeMs,
            coldLoadTimeMs = coldLoadTimeMs,
        )
    }
}
