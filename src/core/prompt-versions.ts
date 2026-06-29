/**
 * 提示词版本登记表 + PromptRole —— 前后端单源（D2 prompt manifest 种子）。
 * server/prompts.ts（SYSTEM_PROMPTS）与 client src/core/pipeline.ts（PROMPT_TAG）共享此表：
 * 改某 role 的 system 文案就 bump 它这条，只此一处，杜绝客户端 tag 与服务端版本手工对齐漂移（R8）。
 * 纯数据、无任何 DOM/平台/server 依赖 → 放 core，两端都可安全 import。
 */
export const PROMPT_VERSIONS = {
  annotator: 'v3',          // /api/chat 主伴读/答问（唯一有状态：每本书 buffer）
  ink_classifier: 'v3',     // /api/interpret 笔迹「手写 vs 画」分类 + 转写 + 草图描述
  context_classifier: 'v3', // /api/classify-context respond/fold
  ocr: 'v3',                // /api/ocr-vlm 转写
  image_explain: 'v3',      // /api/explain-image 图解读
  reflow_refine: 'v3',      // /api/reflow 逐块精修
  reflow_structure: 'v3',   // /api/reflow-ai[-stream] 结构重建
  reflow_vlm: 'v3',         // /api/reflow-vlm 看图重排
  meeting_summary: 'v2',    // /api/chat 会后思路总结（WS2-C·无状态·不进书 buffer）；v2=禁 markdown 纯文本
  segment_digest: 'v1',     // /api/chat 会议某时段一句话摘要（WS2-C V2 概览 active 段·纯文本·无状态）
  concept_extractor: 'v2',  // /api/chat 从一条笔记抽 1-3 个规范概念词（Obsidian 概念层·纯文本逐行·无状态·缓存键含此版本）；v2=治过度抽象/低上下文幻觉/错误复用（真 LLM 探针后）
} as const;

export type PromptRole = keyof typeof PROMPT_VERSIONS;
export function promptVersion(role: PromptRole): string { return PROMPT_VERSIONS[role]; }
