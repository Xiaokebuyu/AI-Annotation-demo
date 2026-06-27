/**
 * 基岩录制器（Tier 1）——"录像机"本体。死区前的每帧采样进内存缓冲，攒批（定时 / 满量）才写 ink_samples。
 * 影子运行：只被 capture tap 在 features.bedrock 开启时调用；完全不碰 marks/ingestStroke。
 * 高频不卡的关键：绝不每帧写 IDB；全程 try/catch，录制坏了也不影响主流程。
 */
import { appendInkChunk, appendInkSegment, pruneBedrock } from './store';
import {
  BEDROCK_SCHEMA_VERSION,
  type DeviceProfile, type InkSample, type PersistedInkChunk, type PersistedInkSegment, type RawRef,
} from '../core/bedrock';
import { shortId } from '../core/ids';
import { devEmit } from '../core/dev-telemetry';

const brief = (s: InkSample): Record<string, unknown> => ({ x: +s.x.toFixed(3), y: +s.y.toFixed(3), phase: s.phase });

const FLUSH_MS = 500; // 多久 flush 一次
const FLUSH_N = 64;   // 攒满多少帧立刻 flush

export interface SampleIn {
  documentId: string;
  pageId?: string;
  x: number; y: number;             // 归一化 [0,1]
  phase: 'down' | 'move' | 'up';
  contactId: number;                // = PointerEvent.pointerId
  pressure?: number;                // >0 才记进 dynamics
  dims: { w: number; h: number };   // 归一化反推用（→ profile.native_*）
  penSource?: boolean;              // 该源能否给压感（pointerType==='pen'）
  surface?: 'article' | 'reader';   // 哪个面（原版页/重排面）；坐标系不同→换面起新段。默认 article
}

let seg: { id: string; docId: string; surface: string; seq: number } | null = null;
let buf: InkSample[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let lastMarkSeq = 0; // 上次 mark 收口时的 seq（raw_ref 回链用，per-segment·起段清零）
let pruned = false;  // 每 app 会话只裁一次旧录像（首次起段时）

function startSegment(s: SampleIn): void {
  const id = shortId('seg');
  const surface = s.surface ?? 'article';
  const profile: DeviceProfile = {
    source: 'pointerevent',
    native_x_max: Math.round(s.dims.w) || 1,
    native_y_max: Math.round(s.dims.h) || 1,
    time_precision: 'ms',
    coalesced: true,
    has_pressure: !!s.penSource,
    has_tilt: false,
    has_hover: false,
  };
  const rec: PersistedInkSegment = {
    segment_id: id, document_id: s.documentId, page_id: s.pageId, surface,
    version: BEDROCK_SCHEMA_VERSION, profile,
    anchor: { wall_clock_iso: new Date().toISOString(), mono_ms_origin: Math.round(performance.now()) },
    created_at: new Date().toISOString(),
  };
  seg = { id, docId: s.documentId, surface, seq: 0 };
  lastMarkSeq = 0;
  if (!pruned) { pruned = true; void pruneBedrock(); } // 每 app 会话首次起段时裁一次旧录像（>14 天）
  void appendInkSegment(rec);
  devEmit('bedrock', () => ({ ev: 'segment', segment_id: id, document_id: s.documentId, page_id: s.pageId, surface, profile, anchor: rec.anchor }));
}

/** 把缓冲里的采样打成一块写库（定时 / 满量 / 换书时调）。 */
export function flushBedrock(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!seg || !buf.length) return Promise.resolve();
  const samples = buf; buf = [];
  const chunk: PersistedInkChunk = {
    chunk_id: shortId('chk'), segment_id: seg.id, document_id: seg.docId,
    seq_from: samples[0].seq, seq_to: samples[samples.length - 1].seq,
    samples, created_at: new Date().toISOString(),
  };
  devEmit('bedrock', () => ({ ev: 'chunk', segment_id: chunk.segment_id, n: samples.length, seq_from: chunk.seq_from, seq_to: chunk.seq_to, first: brief(samples[0]), last: brief(samples[samples.length - 1]) }));
  return appendInkChunk(chunk);
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushBedrock(); }, FLUSH_MS);
}

/** capture tap 每点调一次。换书自动起新段；攒批写库。录制失败静默吞，不影响主流程。 */
export function recordInkSample(s: SampleIn): void {
  try {
    if (!seg || seg.docId !== s.documentId || seg.surface !== (s.surface ?? 'article')) { void flushBedrock(); startSegment(s); }
    const sample: InkSample = {
      seq: seg!.seq++,
      mono_ms: Math.round(performance.now()),
      contact_id: s.contactId,
      phase: s.phase,
      x: s.x, y: s.y,
    };
    if (s.pressure && s.pressure > 0) sample.dynamics = { pressure: s.pressure };
    buf.push(sample);
    if (buf.length >= FLUSH_N) void flushBedrock();
    else scheduleFlush();
  } catch { /* 录制不可影响主流程 */ }
}

/** 标注收口时调：返回"上次收口以来"录的 seq 区间（= 这个 mark 那几笔的采样；笔间无采样故精确）。
 *  无当前段 / 该段非本书 / 期间无采样（如 reader 面未接录）→ undefined。 */
export function bedrockMarkBoundary(documentId: string): RawRef | undefined {
  if (!seg || seg.docId !== documentId) return undefined;
  const seqTo = seg.seq - 1; // 最后已记 seq（seg.seq 是下一个待分配）
  if (seqTo < lastMarkSeq) return undefined; // 这个 mark 期间没录到采样
  const ref: RawRef = { segment_id: seg.id, seq_from: lastMarkSeq, seq_to: seqTo };
  lastMarkSeq = seg.seq;
  return ref;
}
