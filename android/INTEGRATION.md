# InkLoop 安卓壳 · 构建与集成

把 InkLoop（Vite/TS 前端）装进原生 Kotlin WebView 壳，跑在 RK3588S 安卓板上；AI 走托管代理，
端侧 OCR 通过 `window.InkLoopOcr` 桥接 POC 的 PP-OCR。**侧载，不上 Google Play**。

本机无安卓构建链（无 SDK/gradle/JDK），故这里是**待 Android Studio 构建的源码**。分两阶段：
**Phase 1 = 套壳 MVP（先验"网页能上板 + 云端答问"）**，**Phase 2 = 接端侧 OCR**。

## 前置
- Android Studio（含 JDK 17、Android SDK）。打开 `android/` 时它会自动补齐 Gradle wrapper jar。
- 版本组合保守可调：AGP 8.5.2 / Kotlin 1.9.24 / Gradle 8.7 / compileSdk 34 / minSdk 26 / targetSdk 34。
  侧载无 Play 红线，可按需上调到 35/36（同步 AGP 与 wrapper）。
- 包名 `com.inkloop.app`（可改）。

---

## Phase 1 · 套壳 MVP

### 1. 部署 AI 代理
前端的 `/api/*` 在 `npm run build` 后不存在（dev 期是 Vite 中间件）。需把 `server/standalone.ts`
跑成常驻 HTTPS 服务（复用 `server/infer.ts` 的 9 路由，Key 只在服务端）：
```bash
# 在能被板子访问到的主机上（云 VM / LAN）
LLM_GATEWAY_KEY=... LLM_MODEL=kimi-k2.6 PORT=3000 npm run serve   # = tsx server/standalone.ts
```
- CORS 已放行 `https://appassets.androidplatform.net`（WebView 页面 origin）；额外 origin 用 `CORS_EXTRA_ORIGIN`。
- 生产走 **https**。仅调试期若代理在 LAN 走 http：在 `network_security_config.xml` 放开你的主机 IP。
- 经 Nginx 时关 `proxy_buffering`（保流式 `/api/chat`、`/api/reflow-ai-stream`）。

### 2. 构建前端（注入代理地址）
```bash
VITE_API_BASE_URL=https://<your-proxy> npm run build
```
（`base:'./'` + pdfjs 相对路径 + `VITE_API_BASE_URL` 已在前端就位。）

### 3. 同步资产进安卓工程
```bash
node scripts/sync-android-assets.mjs
```
把 `dist/`（+ 端侧 models/dict）拷进 `android/app/src/main/assets/`。
WebViewAssetLoader 把 URL `/assets/` 映射到该目录，故页面地址 = `https://appassets.androidplatform.net/assets/index.html`。

### 4. 构建 & 侧载
Android Studio 打开 `android/` → 运行 `:app` → 出 debug APK → `adb install` 到 RK3588S（或模拟器）。

### 5. 验收（套壳通路）
导入数字版 PDF（系统 SAF 选择器）；笔采集 + 压感；圈/划/写停笔出 AI 旁注（经代理往返）；
重排切换；关 App 重开最近文档仍在（IndexedDB）；断网阅读不崩；AI 不可用时 UI 降级不白屏。

> Phase 1 不含 OcrBridge：`window.InkLoopOcr` 不存在 → 前端 `ondevice.available()=false` → 识别走云端。

---

## Phase 2 · 接端侧 OCR

### 1. 把端侧源码移入编译源集
统一移到 `android/app/src/main/java/com/example/hmpocrpoc/`（保持 package 不变）：
- 本仓库 `android/phase2-ondevice/com/example/hmpocrpoc/OcrBridge.kt`（桥；Phase 1 故意不放编译树，避免引用未拷入的 POC 类导致编译失败）。
- POC：`PpOcrBridge.kt`、`IntentClassifier.java`、`HandwritingReranker.java`、`EnglishDictionary.java`
  （用 ML Kit 还需 `DigitalInkBridge.kt`）。源在 `端侧ocr方案/src/main/java/com/example/hmpocrpoc/`。

`OcrBridge` 与它们同包，可直接访问其包级私有成员，无需改可见性。

### 2. 加依赖（`app/build.gradle.kts` 取消注释）
- **PaddleOCR + OpenCV**：徐智强 的 PP-OCR Android SDK（`com.paddle.ocr.*`）无公开 Maven 坐标——
  向他要 AAR 放 `app/libs/`（`implementation(files("libs/paddle-ocr.aar"))`）+ OpenCV（`org.opencv:opencv:4.9.0` 或他用的版本）。
- `org.jetbrains.kotlinx:kotlinx-coroutines-android`（PpOcrBridge 用）。
- 模型/词典已由 sync 脚本放进 `assets/models`、`assets/dictionaries`。

### 3. 启用桥
`MainActivity.kt` 里取消注释：
```kotlin
com.example.hmpocrpoc.OcrBridge.attach(webView, this)
```

### 4. 验收（端侧识别）
手写后看：识别本地出文字（前端开发面板/遥测 `recognize` 阶段 `识别源=local_board`）；量延迟、与云端对照；
`capabilities()` 正确反映 GMS。

### Phase 2 · ML Kit（可选手写增强，需 GMS）
裸 AOSP 板多无 GMS → `hasGms()=false`，自动只用 PP-OCR。若板子带 GMS 且要用笔顺动态（手写更准）：
- 加 `play-services-mlkit-digitalink-recognition` + `play-services-base`，拷入 `DigitalInkBridge.kt`。
- 按 `OcrBridge.kt` 文末注释接：strokes → 重建 ML Kit `Ink` → `DigitalInkBridge.recognize` →
  `HandwritingReranker.rerank(...)` 取 `selectedText`。注意语种选 `languageTag`、多笔边界（必要时让前端按 stroke 分组传 `strokes`）。

---

## intent A/B 影子对照（Seam C）
前端在每次手写触发时，除云端 `classifyContext`（respond/fold，**权威**）外，并行调桥 `classifyIntent`
得 POC 规则版 intent → 映射 respond/fold 预测，两者一起记一条 `intent_ab` 遥测算一致率。**端侧只影子、不改行为。**

⚠️ 遥测走 `devEmit`，**仅 DEV 构建生效**（生产零开销）。要在板上的**生产构建**收 A/B 数据，需另加一个持久化端点
（在 `server/standalone.ts` 加 `POST /api/ab/intent` 落 jsonl，并让前端 `emitIntentAb` 直接 POST 它，绕开 DEV 闸）。
首轮在模拟器/dev 构建上验即可（`npm run dev` 的 Vite 中间件已落 `.dev-telemetry.jsonl`，读它算一致率）。

---

## 资产路径备忘（为何这么排）
- `dist/index.html` 用相对 `./assets/...`（`base:'./'`）；页面在 `/assets/index.html` → 解析到 `/assets/assets/...`。
- AssetLoader 前缀 `/assets/` → APK `assets/`，故 `dist/` 平铺进 `assets/` 后：`assets/index.html`、`assets/assets/*.js`、`assets/cmaps/`…一一对上。
- pdfjs 的 cmap/字体用 `BASE_URL` 相对解析（`src/surface/renderer.ts`），同样落到 `/assets/cmaps/`。

## 安全 / 发布
- WebView：关 file 访问、`MIXED_CONTENT_NEVER_ALLOW`、release 关 WebView debugging、外链交系统浏览器。
- 隐私：AI 开启时会把 PDF 文本片段 / 页面图片片段 / 标注内容发到代理。侧载自用无需上架合规，对外分发再补。
