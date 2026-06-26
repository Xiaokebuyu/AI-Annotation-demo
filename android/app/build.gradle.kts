plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.inkloop.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.inkloop.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        ndk { abiFilters += listOf("arm64-v8a") } // 端侧 OCR native（OpenCV/ONNX）只打 arm64，控包体（~71MB）
    }

    buildTypes {
        debug {
            // 内网联调用 debug 包：明文代理豁免在 src/debug/res 的 network_security_config，不进 release。
            isMinifyEnabled = false
        }
        release {
            // R8 混淆 + 资源收缩。保活规则(端侧 OCR native/JS 桥)见 proguard-rules.pro。
            // ⚠ 本机无 Android SDK，未真机验；首次 release 构建须 Android Studio 出包后真机验 OCR/桥不被裁。
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    // ── 套壳：WebView 加载 Vite 前端 + 云端答问 ──
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")

    // ── 端侧印刷区域 OCR（ocrRegion = ML Kit text 优先 + PP-OCR 兜底；手写仍走云，见 OcrBridge.kt）──
    implementation(project(":ppocr-sdk"))                                // 徐 PaddleOCR SDK（com.paddle.ocr）
    implementation("com.google.mlkit:text-recognition:16.0.1")           // 拉丁文（bundled，含 Tasks，不绑 GMS）
    implementation("com.google.mlkit:text-recognition-chinese:16.0.1")   // 中文（bundled）
    implementation("org.opencv:opencv:4.9.0")                            // PpOcrBridge 直接引用 org.opencv.core.Core
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0") // PpOcrBridge 用协程
    // 手写真引擎（商业 raw-stroke HWR SDK）到位后在此加；ML Kit Digital Ink 绑 GMS、目标板多半没有，不默认启用。
}
