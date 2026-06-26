# release 开 R8 minify + shrinkResources（build.gradle.kts）。
# 保活以下：经 JNI/反射访问、R8 静态分析不可见的类（端侧 OCR native）+ JS 桥。
# WebView 前端在 assets/（不被 res 收缩触及）；res 收缩只动 themes/icon/network_security_config（均被 manifest 引用，安全）。
-keep class com.example.hmpocrpoc.** { *; }   # JS 桥 + 端侧 OCR（OcrBridge/EinkBridge/PpOcrBridge/MlKitTextOcrBridge）
-keep class com.paddle.ocr.** { *; }          # 徐 PaddleOCR SDK
-keep class org.opencv.** { *; }              # OpenCV（JNI native）
-keep class ai.onnxruntime.** { *; }          # ONNX Runtime（JNI native）
-keep class com.google.mlkit.** { *; }        # ML Kit text recognition（拉丁+中文）

# JNI：保留所有 native 方法名（本地绑定 R8 不可见）
-keepclasseswithmembernames class * { native <methods>; }
