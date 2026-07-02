/**
 * 基岩（Tier 1 原始运动流）schema v1 —— 死区/组装之前的忠实笔迹记录（"给笔装的录像机"）。
 * 影子运行：与 marks（Tier 2 语义真相）并行，不替代、不干涉；feature flag `bedrock` 默认关。
 * 设计依据：~/Desktop/Nova_project/InkLoop数据架构总纲.md + 基岩 schema 文档。
 * 本文件只放类型；录制在 src/local/bedrock-recorder.ts，落库在 src/local/store.ts（ink_segments/ink_samples）。
 */
export const BEDROCK_SCHEMA_VERSION = '1';

export type BedrockSource = 'evdev' | 'pointerevent';

/** 源档案：每段录制开头记一次。源无关 + 诚实标缺什么维度。 */
export interface DeviceProfile {
  source: BedrockSource;
  native_x_max: number;            // 原生坐标量程（pointerevent=CSS px 宽/高），用于反推原生网格
  native_y_max: number;
  report_hz?: number;
  time_precision: 'ms' | 'sub_ms';
  coalesced: boolean;
  has_pressure: boolean;
  has_tilt: boolean;
  has_hover: boolean;
}

/** 未来维度，今天硬件没有就整体省略（不塞 null）。 */
export interface InkDynamics {
  pressure?: number;
  tilt_x?: number;
  tilt_y?: number;
  hover_dist?: number;
}

/** 一帧笔迹采样：基岩唯一的逻辑记录类型。x,y 归一化 [0,1]。 */
export interface InkSample {
  seq: number;                     // 段内单调自增
  mono_ms: number;                 // 单调时钟读数（performance.now）
  contact_id: number;              // 一笔的稳定身份（pointerId）：down→up = 一笔
  phase: 'down' | 'move' | 'up';
  x: number;
  y: number;
  dynamics?: InkDynamics;
}

/** 段锚：把单调时钟钉到墙钟（配合 mono_ms 还原绝对时刻）。 */
export interface SegmentAnchor {
  wall_clock_iso: string;
  mono_ms_origin: number;
}

/* ── 持久化形态（IndexedDB）──────────────────────────────────────────────
 *   ink_segments：一段录制的头（profile + 时间锚），每段一条。
 *   ink_samples ：批量 flush 的采样块（一块 = 一次 flush 的若干帧），降低 66Hz 高频写。
 * ──────────────────────────────────────────────────────────────────────── */

/** ink_segments 条目（keyPath=segment_id，index by_doc）。 */
export interface PersistedInkSegment {
  segment_id: string;
  document_id: string;
  page_id?: string;
  surface?: 'article' | 'reader';  // 哪个面：原版页(归一化页坐标) / 重排面(reader 内容坐标·坐标系不同)
  version: string;                 // BEDROCK_SCHEMA_VERSION
  profile: DeviceProfile;
  anchor: SegmentAnchor;
  created_at: string;
}

/** ink_samples 条目（keyPath=chunk_id，index by_doc）：一次 flush 的采样块。 */
export interface PersistedInkChunk {
  chunk_id: string;
  segment_id: string;
  document_id: string;
  seq_from: number;
  seq_to: number;
  samples: InkSample[];
  created_at: string;
}

/** 标注 → 基岩回链：这个 mark 的笔迹对应录像里哪一段、哪段 seq（first/last 含）。
 *  精确性来自"笔抬起→下一笔之间无采样"——故"上次收口以来"的 seq 区间正好是这个 mark 那几笔。 */
export interface RawRef {
  segment_id: string;
  seq_from: number;
  seq_to: number;
}
