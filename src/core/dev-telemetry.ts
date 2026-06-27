/**
 * DEV 遥测通道（单一收口）—— 让"开发者侧的 Claude"不进浏览器、只读一个文件，就能看清
 * 一次标注从落笔到产出每一步真实发生了什么。
 *
 * 流向：各观测点 `devEmit(kind, payload)` → POST `/api/__debug/event`
 *       → `server/debug.mjs` 落 `.dev-telemetry.jsonl`(append-only) + 内存环。
 * 读取：直接 Read `.dev-telemetry.jsonl`，或 GET `/api/__debug/snapshot?n=N`。
 *
 * 这是**唯一**的发射器：统一 DEV 闸 + envelope `{ kind, ts, ...payload }` + 容错。
 * 各域只负责把自己的数据"塑形"成 payload（mirror* 函数），传输一律走这里——
 * 不要再在别处手写 `fetch('/api/__debug/event')`。纯 dev：生产构建(import.meta.env.DEV=false)直接跳过。
 *
 * 受众与 IndexedDB 的 PipelineStage(Mark.trace/ai_turn.pipeline，浏览器内 AI 会话页用)互补：
 * 那条是带缩略图的浏览器内复盘；这条是无图、可离线、给开发者侧的精简事实流。
 */

/** dev 事件类型（一次标注的各观测点）。改这里＝改 taxonomy，server 端无需同步（它只透传）。 */
export type DevEventKind =
  | 'gesture'    // 组装定型：一次组装手势的笔画构成(类型+分)、feature/shape、flush(收口原因/时长/区域)
  | 'recognize'  // 识别裁判：freeform 是否送 /api/interpret、为何跳过、判定 kind/转写/描述、feature_in→out
  | 'hmp'        // HMP 取证：mode/action/object_hint/命中对象(解析原文)/有无图/置信
  | 'recall'     // 空间召回：逐候选 euclid/dy/dx/sameRow/verdict + 目标锚点笔 + 阈值
  | 'inferview'  // 蒸馏载荷：喂模型前的 narrative/marked/question/锚点/滑窗长度
  | 'classify'   // 上下文分类器：respond/fold 判定 + 理由
  | 'intent_ab'  // 端侧 intent A/B 影子：云端 respond/fold vs 端侧规则 IntentClassifier 预测 + 一致否
  | 'inference'  // 主模型一轮：真实 system/task、focus、回复、计时、当前设置快照
  | 'pageocr'    // 图片版/扫描页 OCR 文本层：phase(layer位置层/flat纯文本/none)、blocks/chars、source、延迟、样本文字
  | 'relviz'     // 关系图可视化（dev 叠层）调试
  | 'bedrock';   // 基岩录制（Tier 1 影子）：起段(profile/锚) + 每次 flush 的采样块摘要(帧数/seq区间/首末帧)

const DEV = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * 发射一条 dev 事件。仅 DEV；fire-and-forget；任何失败(取值/序列化/网络/dev sink 不在)都不连累 UI。
 * `build` 是**惰性 thunk**：生产构建下根本不调用——payload 既零开销、又不可能抛。
 * envelope `{ ts, ...payload, kind }`：
 *   · `kind` 放**末尾、永不被 payload 覆盖**——曾因 recognize 的 payload 自带 `kind` 字段（VLM 判定值）
 *     spread 覆盖掉事件类型 'recognize'、把事件改名成 'sketch'，故钉死在最后。payload 别再用 `kind` 字段名。
 *   · `ts`=客户端事件时刻、放最前，**payload 可覆盖**（inspect 用 rec.ts 回填记录自身时刻）；server 另盖 `t`=落库时刻。
 */
export function devEmit(kind: DevEventKind, build: () => Record<string, unknown>): void {
  if (!DEV) return;
  try {
    const payload = build();
    void fetch('/api/__debug/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: new Date().toISOString(), ...payload, kind }),
    }).catch(() => { /* dev sink 不在/出错都无所谓 */ });
  } catch { /* 取值/序列化出错也不连累 UI */ }
}
