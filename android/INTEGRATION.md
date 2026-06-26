# InkLoop 安卓壳 · 构建与集成

把 InkLoop（Vite/TS 前端）装进原生 Kotlin WebView 壳，跑在 RK3588S 安卓板上。**侧载，不上 Google Play**。
AI 答问走托管代理（云/内网）；**端侧印刷区域 OCR** 通过 `window.InkLoopOcr` 桥本地跑徐的 PaddleOCR / ML Kit text。

> 形态（2026-06-24 定）：**我们的脚手架为主体，把徐的 `ppocr-sdk` 作为源码模块拉进来**。
> 本机无安卓构建链（无 SDK/gradle/JDK），故这里是**待 Android Studio 构建的源码**，未编译验证过。

## 端侧职责映射（对齐徐架构，详见记忆 inkloop-android-wrapper-branch『分类器端侧平替映射』）
- **印刷/规整文字区域 OCR → 端侧**：`ocrRegion` = ML Kit text（Latin+中文，bundled 离线、不绑 GMS、~178ms）优先，空/失败退 PP-OCRv6 兜底（~435ms）。**这是端侧唯一真正承载的活。**
- **手写「判 kind + 转写 + 画描述」→ 云端**：端侧无可用手写引擎（Digital Ink 绑 GMS、目标板多半没有；栅格读手写不可用）。`recognizeInk` 端侧恒返回 unavailable → 前端自动降级云 `/api/interpret`（VLM）。待商业 raw-stroke HWR SDK 到位再接（见下）。
- **intent（respond/fold 影子）→ 前端 TS**：`intent-rules.ts` 已权威执行，桥 `classifyIntent` 不重复。

## 版本组合（对齐徐 ppocr-sdk，已写进构建文件）
AGP 8.7.3 / Kotlin 2.1.0 / Gradle 8.9 / compileSdk 35 / minSdk 26 / targetSdk 35 / **abiFilters = arm64-v8a**。
包名 `com.inkloop.app`。模块：`:app`（壳 + OcrBridge）、`:ppocr-sdk`（徐 PaddleOCR 源码，`com.paddle.ocr`）。

---

## 构建步骤

### 1. 部署 AI 代理
前端 `/api/*` 在 `npm run build` 后不存在（dev 期是 Vite 中间件）。把 `server/standalone.ts` 跑成常驻服务（复用 `server/infer.ts` 的 9 路由 + `/api/ab/intent`，Key 只在服务端）：
```bash
LLM_GATEWAY_KEY=... LLM_MODEL=kimi-k2.6 PORT=3000 npm run serve   # = tsx server/standalone.ts
```
- 现已部署内网 `10.4.36.30:3000`（`/root/inkloop-proxy`，`nohup`）。CORS 已放行 `https://appassets.androidplatform.net`、禁 `/api/__debug/*`。
- 内网走 http：`network_security_config.xml` 已放行该 IP。公网请走 https。经 Nginx 关 `proxy_buffering`（保流式）。

### 2. 构建前端（注入代理地址）
```bash
VITE_API_BASE_URL=http://10.4.36.30:3000 npm run build
```

### 3. 同步资产进安卓工程
```bash
node scripts/sync-android-assets.mjs
```
把 `dist/`（+ 端侧 `models/`、`dictionaries/`）拷进 `android/app/src/main/assets/`（gitignore，不入库）。
页面地址 = `https://appassets.androidplatform.net/assets/index.html`。
> **PP-OCR 模型只由 app assets 这一份提供**（`assets/models/det|rec`）。徐 `ppocr-sdk` 自带的 models 已在拉入时删掉，避免 asset 合并冲突——`PpOcrBridge` 从 app 合并 assets 读 `models/det/inference.onnx` 等，能读到这份。

### 4. 构建 & 侧载
Android Studio 打开 `android/` → Gradle sync（首次下 AGP/Kotlin/OpenCV/ONNX 依赖）→ 运行 `:app` → debug APK → `adb install` 到板子。
> **abiFilters=arm64-v8a**：APK 只含 arm64 native（OpenCV/ONNX/ML Kit），约 71MB。**只能装 arm64 设备/模拟器**（真板，或 Apple Silicon 上的 arm64 系统镜像）。要在 x86_64 模拟器快速验套壳，临时去掉 `app/build.gradle.kts` 的 `abiFilters` 即可（包体涨到 ~291MB）。

### 5. 验收
- **套壳通路**：SAF 导入 PDF；笔采集+压感；圈/划/写停笔出 AI 旁注（经 `10.4.36.30` 往返）；重排切换；关 App 重开最近文档仍在（IndexedDB）；断网阅读不崩、AI 不可用降级不白屏。
- **端侧 OCR**：圈选印刷文字区域 → 前端开发面板/遥测 `ocr_fallback` 阶段应显示本地读出（不再打云端 `/api/ocr-vlm`）。手写仍走云（`recognize` 阶段 `识别源=cloud`），符合预期。

---

## 端侧 OCR 桥怎么工作（`OcrBridge.kt`）
`MainActivity` 在 `loadUrl` 前 `OcrBridge.attach(webView, this)` 注册 `window.InkLoopOcr`。RPC 契约见 `src/evidence/ondevice.ts`：
```
REQ  {"id","method","args"}   method ∈ ocrRegion | recognizeInk | classifyIntent | capabilities
RES  {"id","ok":true,"result":{...}}  或  {"id","ok":false,"error":"..."}
```
- `ocrRegion(imagePng)` → `MlKitTextOcrBridge.recognizeLatinChinese` 优先；空/失败 → `PpOcrBridge.recognize` 兜底 → `{text}`。
- `recognizeInk` → `ok:false`（端侧无手写引擎）→ 前端降级云 `/api/interpret`。
- `classifyIntent` → `ok:false`（前端 TS 已做）。
- `capabilities` → `{ocr:true, gms:<反射探测 Play 服务>}`。
> 要纯套壳（全部走云）：注释 `MainActivity` 里的 `OcrBridge.attach` 那一行即可，`window.InkLoopOcr` 不存在 → 前端 `ondevice.available()=false` → 一切走云。

## 手写真引擎槽位（待接）
拿到**商业 raw-stroke HWR SDK**（汉王/Onyx 厂商 SDK / MyScript iink / SELVAS）后，在 `OcrBridge.recognizeInk` 里接：`args.strokes` 笔迹点序 → SDK 识别取候选+重排 → `{kind:"handwriting", reading, description:""}`。在此之前恒走云，不阻塞。
> ML Kit Digital Ink 绑 GMS，徐汉王 T10CPlus 实测 `requires the Google Play Store` 初始化失败、已禁用；目标 RK3588 板多半无 GMS。**故不把 Digital Ink 作为默认手写实现**——它是"dev 能跑、prod 死"的陷阱。

## intent A/B 影子对照（Seam C）
前端每次手写触发：除云端 `classifyContext`（respond/fold，**权威**）外，并行用 `intent-rules.ts`（徐 IntentClassifier 的 TS 移植）算 intent → 映射 respond/fold 预测 → 记一条 `intent_ab`（`devEmit` 落 `.dev-telemetry.jsonl`）+ `postBeacon('/api/ab/intent')`（代理落 `.ab-intent.jsonl`，板上生产也发）。**端侧只影子、不改行为。** 收一致率：读这两个 jsonl 的 `agree` 字段。

---

## 资产路径备忘（为何这么排）
- `dist/index.html` 用相对 `./assets/...`（`base:'./'`）；页面在 `/assets/index.html` → 解析到 `/assets/assets/...`。
- AssetLoader 前缀 `/assets/` → APK `assets/`，故 `dist/` 平铺进 `assets/` 后路径一一对上。
- pdfjs cmap/字体用 `BASE_URL` 相对解析（`src/surface/renderer.ts`），落到 `/assets/cmaps/`。

## 安全 / 发布
- WebView：关 file 访问、`MIXED_CONTENT_NEVER_ALLOW`、release 关 WebView debugging、外链交系统浏览器。
- 隐私：AI 开启时会把 PDF 文本片段 / 页面图片片段 / 标注内容发到代理。侧载自用无需上架合规。
