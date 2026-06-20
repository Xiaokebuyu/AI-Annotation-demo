/**
 * 本地持久化格式 v0 —— 「低成本语义序列」的落地（徐智强：低成本序列才是壁垒）。
 *
 * 存的不是 PDF、不是页面图，而是每页的**语义蒸馏**：重排结构 + 两段记忆 + 图像解读 + 标注。
 * 文字级，几 KB/页，墨水屏轻松装下；浏览器用 IndexedDB，映射到设备 SQLite（PRD §8）。
 * 改动递增 version 并通知两组（决策 D4）。归属上属 B 组「序列化在 OCR 之后、推理之前」，
 * solo 阶段先做，格式按 contract 设计，团队并行时交还/对齐。
 */
import type { NormBBox, ScreenOverlay, StrokePoint } from './contracts';
import type { ReflowBlock } from '../surface/reflow';

export const STORE_VERSION = '1'; // bump：撤逐页记忆字段（旧 doc 缓存失效=重排一次再生）

/** 一张图的解读：图本身可从 PDF 重渲，故只存 bbox + 文字解读。 */
export interface PersistedImage {
  bbox: NormBBox;
  explanation: string;
}

/**
 * 书籍持久化（阶段一）：导入的 PDF 原始字节落库，重开即免重导。
 * 存 Blob（IndexedDB 原生支持），键 document_id（= 'doc_'+sha256[:12]，重复导入稳定）。
 * 与"语义蒸馏只存文字级"的原则不冲突——这是另一个 store（pdf_blobs），独立于 docs 的轻量蒸馏。
 */
export interface PersistedPdfBlob {
  document_id: string;
  blob: Blob;
  stored_at: string;
  size_bytes: number;
}

/** 一笔的低成本序列：源 stroke 无损留在 trace（ADR D3）；这里存归一化点串复原原貌。 */
export interface PersistedStroke {
  tool: 'pen' | 'highlighter' | 'eraser' | 'hand';
  points: StrokePoint[];
}

export interface PersistedPage {
  page_index: number;
  reflow: ReflowBlock[] | null;   // 预排版结构（null = 未排版）
  reflow_engine: string | null;   // 产出该重排的引擎（local/hybrid/vision）—— 切引擎需重排
  images: PersistedImage[];
  strokes: PersistedStroke[];     // 原始笔迹（按页存，可视恢复）
  overlays: ScreenOverlay[];      // AI 卡片（按 overlay_id upsert 自带状态）
  status: 'pending' | 'reflowed' | 'done';
}

export interface PersistedDoc {
  document_id: string;
  file_hash: string;
  filename: string;
  page_count: number;
  saved_at: string;
  version: string;
  last_read_page?: number;        // 阅读位置：重开跳回（老格式缺 = 0）
  pages: Record<number, PersistedPage>;
}
