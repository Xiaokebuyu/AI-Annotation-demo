# InkLoop · AI 标注阅读 demo

在原文上**圈、划、写**，停笔片刻，AI 以低打扰的旁注在标注旁/页边轻声指路；翻页后还记得你前面读过什么。

> A 组（实时闭环组）验证工程。第一周定位：用 Web 验证「标注 → 理解 → 回屏」的交互与数据闭环（决策 D2：脚手架运行时可换，设计语言与契约迁移到硬件电子纸）。

---

## 快速开始

```bash
npm install
cp .env.example .env      # 然后填入网关 Key（见下「团队上手」）
npm run dev               # http://localhost:8765
```

- `?dev=1` 或按 `d` 唤出**开发面板**（provider 切换 / 行为设置 / 坐标自测 / 延迟 / trace）。
- `npm run check` 跑 TS 严格类型检查；`npm run build` 类型检查 + 生产构建。
- 导入**数字版 PDF**（有文本层的）效果最佳——扫描版要等 B 组 OCR。

---

## 核心交互

### 1. 手势集（符号 = 意图，纯几何识别，0 OCR）

笔迹无损采集（Pointer Events，决策 D3），`classifyScored` 按几何给每笔打**相似度分**——画得像范例才算手势，随手涂、半截笔画被忽略（门槛 `GESTURE_MIN_SCORE`）。

| 手势 | 含义 | AI 行为 |
|---|---|---|
| **圈** ◯ | 这是什么 | 解释圈住的概念 |
| **划线** ‾ | 重点 | 提炼要点 + 为什么重要 |
| **圈 + 记号(问号)** | 提问 | 针对圈住的内容直接作答 |
| **写字（页边批注）** | 自由批注 | 把手写当想法，结合附近正文呼应（手写内容读取待 B 组 OCR） |

「圈住了什么字」靠**标注 bbox 与 PDF 文本层几何相交**取得（数字版免 OCR）——不是看截图。

### 2. 段落讨论触发（防打扰 + 原地更新）

同一段上的连续手势聚成一次**讨论**；**停笔 `pauseSeconds`（默认 5s）后才生成**（避免边画边弹）；同段继续画 → **原地刷新同一条**（按 `discId` upsert），不每段各占空间。

### 3. AI 注的落点

- **页面模式**：右侧留白（gutter），按标注 y 对齐、多条防重叠下推；或切「贴正文浮动」。
- **重排模式**：绝对定位进右侧留白、与所属段同行对齐、斜体 + 半透明、不进文档流（**零排版变动**）。
- 全局开关在开发面板「输出落点」。

### 4. 重排阅读（reader mode）

顶栏「重排」切换 **原版 PDF ⇄ 重排**。把文本层重排成干净单栏版心，**重排可圈画**（手势命中哪一段就用该段的原页 bbox 入管线）。三档引擎（开发面板「重排引擎」）：

- `local`：纯几何启发式，离线即时、保 bbox。
- `hybrid`：几何打骨架 + 模型逐块精修（纯文字），保 bbox。
- `vision`：几何打骨架 + **Kimi 看页面图**重判角色/阅读顺序（多栏/标题更准），按 id 重排不合并拆分 → 原页 bbox 原样保留。

> 重排只保留**逻辑结构**（标题/段落/顺序），不保留视觉版式；想要原版式就用「原版 PDF」。

### 5. 跨页阅读记忆（让 AI 读懂全书而非一页）

- 每段讨论记一条标注记忆（符号 + 原文 + AI 回应，逐页存）。
- **翻页时**把上一页压成一句摘要（`/api/summarize`）。
- 答题时模型**按需 `recall_page(n)`** 回看相关前页来综合（Kimi 工具循环）；回看了哪些页在开发面板可见。

---

## 架构

```
src/
  core/         纯逻辑，无 DOM
    contracts.ts   七个 v0 数据契约（D1 归一化坐标 / D3 stroke 无损 / D4 version 冻结）
    transform.ts   坐标换算唯一入口 + GUTTER 布局常量
    classify.ts    笔迹几何分类 + 相似度分（classifyScored）+ 求解意图
    gesture.ts     手势集（圈/划/问/写 → 意图）+ 形状门槛 isDeliberate
    reflow.ts      本地启发式重排（行→段→标题，保 bbox，确定性 id）
    memory.ts      逐页阅读记忆 + 跨页快照（喂 Tier2 recall）
    pipeline.ts    recordEvent（逐笔无损）+ commitDiscussion（段落讨论 upsert）+ summarizePage
    ids / trace / metrics
  providers/    可替换接缝（契约即接口，B 组在此接真实现）
    ocr.ts         textlayer(真实) / mock / vlm(stub) / local(B 组)
    inference.ts   mock / fail / cloud(→ 本地 /api/infer 代理 → 网关)
    reflow.ts      local / hybrid / vision
  ui/           DOM 层
    renderer / ink / whisper(页面留白) / reader(重排面+行内注) / insight-panel / toolbar / dev-drawer
  app/state.ts  事件总线 + 全局状态 + 行为设置(settings)
  main.ts       装配 + 手势调度（组装窗 + 停顿窗）+ 翻页总结
server/infer.ts dev 代理逻辑：runInference（单发 / Tier2 工具循环）/ runReflow / runSummarize
vite.config.ts  /api/infer · /api/reflow · /api/summarize 中间件（Key 留服务端）
```

**数据流**：笔迹 → 手势分类/门槛 → 段落聚类 → `commitDiscussion`（OCR 取圈住原文 → 推理 → overlay）→ 渲染 + 记入逐页记忆。

---

## AI 网关

- **当前底座 = 裸 `fetch` 打 NoDesk AI Gateway**（Anthropic 兼容 `/v1/messages`，body 注入 `channel/channel_url`）。**不是** `@anthropic-ai/sdk`（该包当前闲置，可清）。
- 默认模型 `kimi-k2.6`（moonshot，支持视觉 + 工具调用，已验证）。
- **切 Sonnet**：改 `.env` 的 `LLM_MODEL=claude-sonnet-4-6` 即可（channel 自动路由到 DMXAPI，需该账户有余额）。
- 三个 dev 端点（Vite 中间件，仅开发期）：`/api/infer`（旁注/讨论，可走 Tier2 工具循环）、`/api/reflow`（重排精修，可带页面图）、`/api/summarize`（翻页摘要）。
- **Key 只在服务端**（`.env` → `process.env`），绝不进前端 bundle；`source_refs` 由服务端从请求装配，不让模型编造（PRD 红线）。

---

## 配置旋钮

| 旋钮 | 默认 | 位置 |
|---|---|---|
| 形状门槛 `GESTURE_MIN_SCORE` | 0.4 | `src/core/gesture.ts` |
| 聚簇纵向间隙 `GAP` | 0.06 | `src/main.ts` |
| 停笔生成秒数 `pauseSeconds` | 5 | 开发面板 |
| 右侧留白宽 `GUTTER_W` | 300 | `src/core/transform.ts` |
| 模型 `LLM_MODEL` | kimi-k2.6 | `.env` |
| 输出落点 / 重排引擎 / 手势开关 | — | 开发面板 |

---

## 诚实边界

- `textlayer` 取文本只对**数字版 PDF**精确；扫描版 / 手写内容要 OCR（B 组 B3）。
- 多栏 / 表格 / 图 / 公式：本地启发式搞不定，用 `vision` 引擎或等 VLM 文档解析（B 组 C 档）。
- 「圈+问号」是「圈 + 任意小记号」的几何近似；精确符号意图最终靠 LLM。
- 重排圈画的命中容差 / 停顿时长仍在调手感。
- Sonnet 经 DMXAPI 当前欠费、Bedrock 在内网——故默认用 Kimi。

---

## 项目盘点（截至 2026-06-13）

### 一、完成度（对照第一周计划任务 ID）

**A 组（实时闭环组，本工程覆盖了 Dev A + Dev C 全部任务）—— A1–A11 在 Web 上全部跑通：**

| 任务 | 状态 |
|---|---|
| A1 PDFDocument/PDFPage 契约 | ✅ contracts.ts |
| A2 AnnotationEvent（stroke/highlight/circle/underline/tap_region） | ✅ |
| A3/A4 屏幕路径 + 页面渲染 | ✅ PDF.js 桌面模拟器 |
| A5/A6 PDF ingest + 标注 listener（≤1s 出 event） | ✅ |
| A7 Pointer Events 触摸/笔采集（无损） | ✅ ink.ts |
| A8 云端推理 API client | ✅ /api/infer 代理 |
| A9/A10 overlay renderer + 回屏更新 | ✅ whisper / reader |
| A11 error/retry/timeout 不崩 | ✅ errorResult 降级 |

**B 组任务（理解推理组）—— 为把 demo 跑整，本工程替 B 组填了几处：**

| 任务 | 状态 / 归属 |
|---|---|
| B1 OCRResult 契约 / B2 trace / B5·B8 trace 写入 | ✅ 契约/trace 共建 |
| B3 离线 OCR worker（PaddleOCR） | ⛔ 未做；用 textlayer（数字版免 OCR）+ stub 占位 → **B 组本职** |
| B6 context builder（nearby text / OCR blocks / 跨页 context） | ⚠️ 本工程实现了 → **B 组本职（越界）** |
| B7 result taxonomy（5 类输出模式） | ✅ 共建，已用 |
| B9 真实云端推理模型 | ⚠️ 接了 Kimi → 模型/推理是 **B 组本职**；越界 |
| B10 端到端 trace viewer | ✅ 开发面板（含引用 + 回看监控） |
| B11 MCP/CLI 只读 | ⛔ P1，未做 |

**第一周 Demo（I1 闭环）：已达成**——PDF 导入→渲染→标注→（textlayer 代 OCR）→**真实 Kimi 推理**→overlay 回屏→trace 可复现。I3「真·离线 OCR 报告」未做（无 PaddleOCR）。

### 二、本职 vs 越界（角色边界）

- **Dev C 本职（你的位，稳在界内）**：页面渲染、标注/笔迹采集、overlay 回屏、坐标换算、设备/模拟器——A4/A7/A9/A10 都是你的，且都完成。
- **Dev A 的活（A 组队友，本工程一并做了）**：契约 A1/A2、ingest A5、listener A6、API client A8、降级 A11——属 A 组内，但不是 Dev C 的位。
- **越界到 B 组（demo 打通用，本应归 B 组）**：
  - **context builder（B6）**：圈住原文的 nearby_text 拼装 + 跨页记忆/脉络。
  - **真实推理模型（B9）**：Kimi 接入（API client 那半属 A 组，模型/推理这半属 B 组）。
  - **文档重排 / layout parser**：PRD 把"标题/段落/表格粗分类"列在 OCR 的 B 档/C 档（VLM 文档解析）——本工程做了 local 启发式 + vision 重排当占位。
  - **跨页 agent 记忆**：属 annotation context，B 组线。
  - **低成本语义序列**：ADR 明确「序列化在 OCR 之后、推理之前，归 B 组」；会上"让小克研究"= 我做**格式研究**（非 A 组 build）。手势几何分类是其前端雏形，正式序列化归 B 组。
  - → 这些都做成了 **provider 接缝**（ocr/inference/reflow），标了"B 组接入点"。solo demo 阶段填上无妨，**团队并行时应交还 B 组 / 走 contract 对齐**，否则有 A/B 协议漂移风险。
- **我们自创（不在任何文档里，本项目的设计）**：v1 手势集词表、形状门槛、段落讨论触发（5s+聚类+原地更新）、重排 reader + 三档引擎、右侧留白/行内注落点、跨页 recall 工具循环、NoDesk 网关 + Kimi 选型。

### 三、技术规范：照文档 vs 自己实现

**照技术文档（严格遵守）**：四条定死决策 **D1 归一化坐标 / D2 Web 渲染层 / D3 stroke 无损 / D4 契约冻结**全部遵守；七个 v0 数据契约 + version 冻结（新增的跨页 `memory` 是 **proxy 级 wire 附加，不动冻结的 typed 契约**）；result taxonomy（5 类）、source_refs 可追溯不编造（PRD 红线，服务端装配）；PRD 护城河「局部 OCR + nearby text builder」、交互原则「不抢笔 / 电子纸减动画 / 接受·编辑·忽略 / 旁注」。

**自己实现（文档未规定）**：手势→意图的词表与门槛；段落讨论触发与原地更新；重排的 reader 化与 local/vision 实现；AI 注落点与防重叠；跨页 recall 工具循环；网关与模型选型。

### 四、当前原型 vs 设想原型的差距

- **第一周设想（Web 验证闭环）**：✅ 已达成，且在 AI（真实模型而非 mock）、交互（手势/重排/跨页）上**超出**计划。
- **缺口（相对第一周完整设想）**：真·离线 OCR（PaddleOCR/手写识别）、低成本语义序列格式 + ≥90% 双盲评测、proper layout parser（VLM 文档解析）、设备/开发板实测（现仅桌面模拟器）。
- **相对硬件愿景（PRD AI 墨水屏设备）**：处于「阶段 0 模拟器验证」，距 SOM/EVT/自研主板/native 渲染尚远——但这是 D2 既定路线（Web 先行），不算落后。
- **后置（P1/P2/P3，不该现在做）**：accepted memory 沉淀、用户画像、多文档关联、模板市场、自研硬件。

### 五、方向核对：没有偏离

- **核心方向 = annotation-aware AI（标注即理解 → 贴回原文现场 → 可追溯）**：手势→意图→AI 旁注贴回标注处、source_refs 指回原页 bbox、不抢笔低打扰、电子纸友好——**全部对齐**。
- **需留意（非偏离，是前压/扩张）**：① 重排去掉视觉版式曾与"贴回原文现场"有张力，已用"每块保留原页 bbox + 可切换 + 不强制"化解；② 跨页 agent 超前到 P1/P2；③ **越界 B 组的部分以接缝存在，团队并行时须交还、走契约——这是当前最该盯的协作风险，不是方向问题。**

---

## 团队上手（同组工程师）

1. clone 本仓库，`npm install`。
2. **拿 `.env`**：网关 Key 不进仓库（已 gitignore）。向 xiaokebuyu 索取 `.env` 文件（含 `LLM_GATEWAY_URL` / `LLM_GATEWAY_KEY` / `LLM_MODEL`），放到项目根目录；或 `cp .env.example .env` 后填入 Key。
3. `npm run dev` → 打开 `http://localhost:8765/?dev=1` → 导入数字版 PDF → 圈/划/写，停 5s 看 AI 旁注；切「重排」「重排引擎」看版面理顺；翻页后在新页提问看跨页综合。

> 所有密钥/网关配置都集中在**一个文件 `.env`** 里，方便统一管理与分发。
