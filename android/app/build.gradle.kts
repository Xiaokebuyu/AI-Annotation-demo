plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.inkloop.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.inkloop.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
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
    // ── Phase 1（套壳 MVP）：只要这三个就能跑 InkLoop 网页 + 云端答问 ──
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.webkit:webkit:1.11.0")

    // ── Phase 2（端侧 OCR）：加入下面依赖 + 拷入 POC 源码 + OcrBridge.attach（见 INTEGRATION.md）──
    // PP-OCR：徐智强 的 PaddleOCR Android SDK + OpenCV（无公开 Maven 坐标，需 AAR/源码）：
    // implementation(files("libs/paddle-ocr.aar"))
    // implementation("org.opencv:opencv:4.9.0")
    // implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // ML Kit Digital Ink（可选手写增强，需 GMS）：
    // implementation("com.google.android.gms:play-services-mlkit-digitalink-recognition:18.0.0")
    // implementation("com.google.android.gms:play-services-base:18.5.0")
}
