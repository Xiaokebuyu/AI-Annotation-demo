/**
 * KnowledgeObject —— InkLoop ↔ 协作方（适配器）的**冻结接口**（契约 v0.1 §2）。
 *
 * 金线（来自对方方案 D2）：**适配器只吃 KnowledgeObject**，永不碰 Stroke/HMP/Mark/InferenceView/基岩。
 * 故本文件**刻意零内部 import**——它是边界面，不依赖 InkLoop 内部任何类型，换契约版本也只动这一处。
 * 由 KnowledgeBuilder（builder.ts）从 Tier 2 账本（marks + ai_turns）折叠产出；协作方原样消费。
 * 配套文档：~/Desktop/Nova_project/InkLoop对齐文档-KnowledgeObject契约-v0.1.md
 */

export type ISODateTime = string;
export type Sha256 = `sha256:${string}`;
/** 归一化 [0,1] 边界框 [x, y, w, h]。 */
export type NormBBox = [number, number, number, number];

export type KnowledgeKind =
  | 'source_document'
  | 'excerpt'
  | 'annotation'
  | 'ai_note'
  | 'qa'
  | 'summary'
  | 'task'
  | 'concept';

export type KnowledgeStatus =
  | 'inbox'
  | 'accepted'
  | 'edited'
  | 'dismissed'
  | 'export_ready'
  | 'exported'
  | 'archived';

/** v1 只用这两档（团队/云后置）。 */
export type Privacy = 'local_only' | 'export_allowed';

export type MarkdownCallout = 'note' | 'quote' | 'question' | 'todo' | 'summary' | 'tip';

export const KO_SCHEMA_VERSION = 'inkloop.knowledge_object.v1';

export interface KnowledgeObject {
  schema_version: typeof KO_SCHEMA_VERSION;
  ko_id: string; // 'ko_'+稳定派生（见 builder.koId）；跨端/跨重建稳定身份
  kind: KnowledgeKind;
  title: string;
  body_md: string; // 渲染进受控区块的正文

  source: {
    document_id: string;
    document_title: string;
    page_id?: string; // 'pg_{hash8}_{idx}'
    page_index?: number; // 0-based
    object_refs: string[]; // 命中页面对象 id（字符级，如 'run3_12'）；可空
    anchor_bbox?: NormBBox;
    quote?: string; // 被标注的原文
    inkloop_uri: string; // 见契约 §4
  };

  provenance: {
    created_from: 'mark' | 'ai_turn' | 'session' | 'manual';
    mark_ids?: string[]; // = 我们的 mark_id
    ai_turn_ids?: string[]; // = 我们的 ai_turn entry_id
  };

  tags: string[]; // 默认含 'inkloop' + 'inkloop/<kind>'
  status: KnowledgeStatus;
  privacy: Privacy;

  render_hints?: {
    markdown_callout?: MarkdownCallout;
  };

  content_hash: Sha256; // canonicalJson(KO 去掉本字段) 的 sha256；判重导出
  created_at: ISODateTime;
  updated_at: ISODateTime;
}
