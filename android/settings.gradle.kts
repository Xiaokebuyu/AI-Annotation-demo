pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Phase 2（端侧 OCR）：徐智强 的 PaddleOCR / OpenCV AAR 仓库或 flatDir 在此加入。
    }
}
rootProject.name = "InkLoop"
include(":app")
