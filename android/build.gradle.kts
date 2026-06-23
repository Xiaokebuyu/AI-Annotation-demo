// 顶层构建脚本。版本组合是保守可用值（AGP 8.5 / Kotlin 1.9 / Gradle 8.7 / compileSdk 34）；
// 侧载不上架，targetSdk 无 Play 红线，按需可上调到 35/36（需同步 AGP 与 Gradle wrapper）。
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
