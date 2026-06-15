/**
 * 本地持久化格式 v0 —— 「低成本语义序列」的落地（徐智强：低成本序列才是壁垒）。
 *
 * 存的不是 PDF、不是页面图，而是每页的**语义蒸馏**：重排结构 + 两段记忆 + 图像解读 + 标注。
 * 文字级，几 KB/页，墨水屏轻松装下；浏览器用 IndexedDB，映射到设备 SQLite（PRD §8）。
 * 改动递增 version 并通知两组（决策 D4）。归属上属 B 组「序列化在 OCR 之后、推理之前」，
 * solo 阶段先做，格式按 contract 设计，团队并行时交还/对齐。
 */
import type { NormBBox } from './contracts';
import type { ReflowBlock } from './reflow';
import type { PageMark } from './memory';

export const STORE_VERSION = '0';

/** 一张图的解读：图本身可从 PDF 重渲，故只存 bbox + 文字解读。 */
export interface PersistedImage {
  bbox: NormBBox;
  explanation: string;
}

/**
 * 两段记忆：
 *  - content  记忆A：本页**内容**解读（这页在讲什么）。预处理流水线填，本轮先占位 null。
 *  - activity 记忆B：用户**行为·理解**的一句概述（= 翻页摘要 summary）。
 *  - marks    记忆B 明细（手势 + 圈住原文 + AI 回应）。
 */
export interface PersistedMemory {
  content: string | null;
  activity: string | null;
  marks: PageMark[];
}

/** 标注的低成本序列：源 stroke 无损留在 trace（ADR D3），存储这里可抽稀。本轮字段先定义。 */
export interface PersistedAnnotation {
  discId: string | null;
  gesture: string;
  bbox: NormBBox;
  points?: Array<[number, number]>; // 归一化、抽稀后的点串（可复原大致形状）
}

export interface PersistedPage {
  page_index: number;
  reflow: ReflowBlock[] | null;   // 预排版结构（null = 未排版）
  reflow_engine: string | null;   // 产出该重排的引擎（local/hybrid/vision）—— 切引擎需重排
  images: PersistedImage[];
  memory: PersistedMemory;
  annotations: PersistedAnnotation[];
  status: 'pending' | 'reflowed' | 'done';
}

export interface PersistedDoc {
  document_id: string;
  file_hash: string;
  filename: string;
  page_count: number;
  saved_at: string;
  version: string;
  pages: Record<number, PersistedPage>;
}
