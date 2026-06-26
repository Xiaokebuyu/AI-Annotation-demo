package com.example.hmpocrpoc

import android.graphics.Bitmap
import android.os.SystemClock
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions

object MlKitTextOcrBridge {
    interface Callback {
        fun onSuccess(result: MlKitOcrResult)
        fun onFailure(error: String)
    }

    data class MlKitOcrResult(
        val source: String,
        val text: String,
        val lineCount: Int,
        val blockCount: Int,
        val latinText: String,
        val latinLineCount: Int,
        val chineseText: String,
        val chineseLineCount: Int,
        val latencyMs: Long,
        val latinError: String,
        val chineseError: String,
    )

    private val latinRecognizer by lazy {
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    }

    private val chineseRecognizer by lazy {
        TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
    }

    @JvmStatic
    fun recognizeLatin(source: String, bitmap: Bitmap, callback: Callback) {
        val startMs = SystemClock.elapsedRealtime()
        val task = latinRecognizer.process(InputImage.fromBitmap(bitmap, 0))
        task.addOnSuccessListener { result ->
            val text = result.text.trim()
            callback.onSuccess(
                MlKitOcrResult(
                    source = source,
                    text = text,
                    lineCount = countNonBlankLines(text),
                    blockCount = result.textBlocks.size,
                    latinText = text,
                    latinLineCount = lineCount(result),
                    chineseText = "",
                    chineseLineCount = 0,
                    latencyMs = SystemClock.elapsedRealtime() - startMs,
                    latinError = "",
                    chineseError = "",
                )
            )
        }.addOnFailureListener { error ->
            callback.onFailure(error.stackTraceToString())
        }
    }

    @JvmStatic
    fun recognizeLatinChinese(source: String, bitmap: Bitmap, callback: Callback) {
        val startMs = SystemClock.elapsedRealtime()
        val latinTask = latinRecognizer.process(InputImage.fromBitmap(bitmap, 0))
        val chineseTask = chineseRecognizer.process(InputImage.fromBitmap(bitmap, 0))

        Tasks.whenAllComplete(latinTask, chineseTask)
            .addOnCompleteListener {
                val latinText = if (latinTask.isSuccessful) latinTask.result.text.trim() else ""
                val chineseText = if (chineseTask.isSuccessful) chineseTask.result.text.trim() else ""
                val latinLineCount = if (latinTask.isSuccessful) lineCount(latinTask.result) else 0
                val chineseLineCount = if (chineseTask.isSuccessful) lineCount(chineseTask.result) else 0
                val text = mergeText(latinText, chineseText)
                val latinError = if (latinTask.isSuccessful) "" else latinTask.exception?.stackTraceToString().orEmpty()
                val chineseError = if (chineseTask.isSuccessful) "" else chineseTask.exception?.stackTraceToString().orEmpty()

                if (text.isEmpty() && latinError.isNotEmpty() && chineseError.isNotEmpty()) {
                    callback.onFailure("Latin failed:\n$latinError\nChinese failed:\n$chineseError")
                    return@addOnCompleteListener
                }

                callback.onSuccess(
                    MlKitOcrResult(
                        source = source,
                        text = text,
                        lineCount = countNonBlankLines(text),
                        blockCount = maxOf(
                            if (latinTask.isSuccessful) latinTask.result.textBlocks.size else 0,
                            if (chineseTask.isSuccessful) chineseTask.result.textBlocks.size else 0,
                        ),
                        latinText = latinText,
                        latinLineCount = latinLineCount,
                        chineseText = chineseText,
                        chineseLineCount = chineseLineCount,
                        latencyMs = SystemClock.elapsedRealtime() - startMs,
                        latinError = latinError,
                        chineseError = chineseError,
                    )
                )
            }
            .addOnFailureListener { error ->
                callback.onFailure(error.stackTraceToString())
            }
    }

    private fun lineCount(text: Text): Int {
        var count = 0
        for (block in text.textBlocks) {
            count += block.lines.size
        }
        return count
    }

    private fun countNonBlankLines(value: String): Int {
        return value.lineSequence().count { it.trim().isNotEmpty() }
    }

    private fun mergeText(latin: String, chinese: String): String {
        val out = LinkedHashSet<String>()
        addLines(out, chinese)
        addLines(out, latin)
        return out.joinToString("\n")
    }

    private fun addLines(out: MutableSet<String>, value: String) {
        value.lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .forEach { line ->
                val normalized = line.replace(Regex("\\s+"), " ")
                if (out.none { existing -> sameEnough(existing, normalized) }) {
                    out.add(normalized)
                }
            }
    }

    private fun sameEnough(a: String, b: String): Boolean {
        if (a == b) return true
        val compactA = a.lowercase().filterNot { it.isWhitespace() }
        val compactB = b.lowercase().filterNot { it.isWhitespace() }
        if (compactA == compactB) return true
        if (compactA.length < 4 || compactB.length < 4) return false
        return compactA.contains(compactB) || compactB.contains(compactA)
    }
}
