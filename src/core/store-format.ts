/**
 * 本地持久化格式 —— SSoT 账本（v3 单一真相源落地）。
 *
 * 四件持久（IndexedDB）：
 *   · docs       —— 书目元信息 + 页内容缓存（reflow / 图解 / 阅读位置 / 综合水位线）。**派生缓存**，非真相。
 *   · pdf_blobs  —— 原始 PDF 字节（重开免重导）。
 *   · marks      —— 页账本：一次组装手势的取证 + 构成笔（append-only，擦除=tombstone）。**真相**。
 *   · ai_turns   —— 书日志：AI 一轮回复 + 锚点 + InferenceView 快照（append-only，改/忽略=supersedes）。**真相**。
 *
 * 派生不存（reload 从 marks/docs 现算）：session、mark-graph、实时 InferenceView。
 * 页保持纯净：marks 只装用户笔迹+取证，AI 文本全在 ai_turns（显示靠 anchor refs 挂回页）。
 * 文字级、几 KB/页，墨水屏轻松装下；浏览器用 IndexedDB，映射到设备 SQLite。
 */
import type { HMP, InferenceView, MarkFeatureType, NormBBox, OverlayState, PipelineStage, ScreenOverlay, StrokePoint } from './contracts';
import type { ReflowBlock } from '../surface/reflow';

export const STORE_VERSION = '2'; // 1→2：strokes/overlays 出 docs 进 marks/ai_turns 账本（干净断裂，旧 docs 弃）
export const DB_VERSION = 6;      // v5→v6：marks 加 context_id + by_context 索引（C2 时间脊：按 surface 会话取笔）。升级走幂等基线 + 阶梯迁移（store.ts openDB），老数据不丢

/** 一张图的解读：图本身可从 PDF 重渲，故只存 bbox + 文字解读。 */
export interface PersistedImage {
  bbox: NormBBox;
  explanation: string;
}

/**
 * 书籍持久化：导入的 PDF 原始字节落库，重开即免重导。键 document_id（= 'doc_'+sha256[:12]，稳定）。
 */
export interface PersistedPdfBlob {
  document_id: string;
  blob: Blob;
  stored_at: string;
  size_bytes: number;
}

/** 一笔的低成本序列：归一化点串 + 工具（redraw 据此还原原貌、保多笔保真）。 */
export interface PersistedStroke {
  tool: 'pen' | 'highlighter' | 'eraser' | 'hand';
  points: StrokePoint[];
}

/** docs 的页缓存：只剩重排结构 + 图解（派生缓存）。strokes/overlays 已迁出到 marks/ai_turns 账本。 */
export interface PersistedPage {
  page_index: number;
  reflow: ReflowBlock[] | null;   // 预排版结构（null = 未排版）
  reflow_engine: string | null;   // 产出该重排的引擎（切引擎需重排）
  images: PersistedImage[];
  status: 'pending' | 'reflowed' | 'done';
}

/** 书记录（docs 主键 document_id）：书目元信息 + 页缓存 + 阅读位置 + 综合水位线。 */
export interface PersistedDoc {
  document_id: string;
  file_hash: string;
  filename: string;
  page_count: number;
  saved_at: string;
  version: string;
  last_read_page?: number;            // 阅读位置：重开跳回（老格式缺 = 0）
  synthesis_watermark_seq?: number;   // 综合水位线：seq > 此值的 mark = 未综合(pending)，reload 重建 session
  pages: Record<number, PersistedPage>;
}

/* ── 账本条目（append-only，每条独立 IDB 记录）────────────────────────────── */

/** 条目公共基字段（marks / ai_turns 共用）。 */
export interface BaseEntry {
  entry_id: string;     // shortId('ent')
  document_id: string;
  page_id: string;      // 'pg_{hash8}_{idx}'，规范键
  page_index: number;
  seq: number;          // 每书单调递增（Date.now() 起跳，跨 reload 仍增），驱动折叠/水位线
  created_at: string;   // ISO 墙钟
}

/** 页账本条目 = 一次组装手势（marks store）。is_tombstone=true 表示擦除携同 mark_id。 */
export interface PersistedMark extends BaseEntry {
  mark_id: string;                  // = 代表 event 的 event_id，跨 reload 稳定引用
  strokes: PersistedStroke[];       // 构成笔（tool+points），redraw 保真（不存合并点）
  bbox: NormBBox;                   // union bbox
  tool: 'pen' | 'highlighter';      // 代表工具（自 event_type 派生）
  color: string;                    // 据 tool 派生的颜色（取证完整性；redraw 仍按 tool）
  pointer_type: string;             // pen / touch / mouse / unknown
  device_id: string;
  abs_timestamp: number;            // 组装时 Date.now()（reload 折回 perf 时间线算关系）
  context_id?: string;              // C2 时间脊：落笔时活跃 surface 实例 id（'__reader__' / 'mtg_<id>' / 日记…）；按会话取笔用，老条目缺=undefined
  feature_type: MarkFeatureType;    // markup / handwriting / drawing（路由/显示粗类型）
  feature_confidence: number;
  kind?: string;                   // 识别裁定原始 kind：handwriting/sketch/mixed/none（比 feature_type 更细，保住 mixed=图+字）
  kind_source?: string;            // 谁判的：local_board（端侧 HWR）/ cloud（VLM）
  scored_type: string;             // 中性几何形状（EventType / MarkShape）
  scored_score: number;
  hmp: HMP | null;                 // 取证（落库前剥掉 crop_ref/vector_ref，存料不存图）
  marked_text: string;             // 落笔当时解析好的"所标内容"
  is_tombstone: boolean;           // true = 本条擦除 mark_id（append-only，不就地删）
}

/** 书日志条目 = AI 一轮回复（ai_turns store）。改/忽略=追加新条目带 supersedes。 */
export interface PersistedAiTurn extends BaseEntry {
  overlay_id: string;              // = discId，重建 overlay/锚点用
  overlay: ScreenOverlay;          // 显示快照（restore 直接用）
  overlay_state: OverlayState;     // shown / accepted / edited / dismissed
  user_edited_text: string | null; // edited 时用户改写文本
  ai_reply: string;
  thinking?: string;               // 模型思考过程（仅 Claude 返回；调试/复盘用，不进对话上下文）
  diag?: {                         // 全流程诊断（会话页用户内容块"分类展示"用）
    classify?: { respond: boolean; reason: string } | null; // 上下文分类器判定（仅手写轮；idle 轮为 null）
    sent_image?: boolean;          // 本轮是否随发了合成图/笔迹图
  };
  pipeline?: PipelineStage[];      // 处理流水线（逐组件收到/产出，含缩略图；仅 DEV 落、调试页逐步复盘用）
  anchor: { surface_id: string; mark_ids: string[]; object_refs: string[] }; // 指回页/笔/对象
  inference_view: InferenceView;   // 喂模型的精简载荷快照（crop 已剥），审计/复现
  prompt_snapshot: string;         // 渲染出的用户轮文本（renderUserTurn 结果）
  system_prompt_hash: string;      // 提示词版本标签（如 annotator@v1）；提示词文本在 server/prompts.ts、git 版本化
  settings_snapshot: { inferModel: string; reflowProvider: string }; // 影响取证的配置
  trigger: 'idle' | 'handwriting' | 'discussion';
  model: string;
  supersedes: string | null;       // 被本条取代的上一条 entry_id（同 overlay_id 链）
}

/* ── 会议工作区（v4）────────────────────────────────────────────────────────
 * 顶层实体 = 群聊/工作区（≈一个飞书群）：装该群的会议记录。会议 = 群里的时间事件，
 * 引用已导入资料（document_id），会后留手写档案（marks 账本）+ 思路总结（AI 综合）。 */

/** 会议工作区（≈一个群聊）。source=manual 现阶段手建；接飞书后 source=feishu + feishu_chat_id。 */
export interface PersistedWorkspace {
  workspace_id: string;             // 'ws_'+shortId
  name: string;
  source: 'manual' | 'feishu';
  feishu_chat_id?: string;          // 接飞书后填
  created_at: string;
  updated_at: string;
}

export type MeetingStatus = 'upcoming' | 'live' | 'ended'; // 待开始 / 进行中 / 已结束

/** 一场会议：属某 workspace，引用资料（已导入书的 document_id），会后留手写档案 + 思路总结。 */
export interface PersistedMeeting {
  meeting_id: string;               // 'mtg_'+shortId
  workspace_id: string;
  title: string;
  scheduled_at: string;             // ISO 计划时间（日程聚合 + 状态派生用）
  status: MeetingStatus;
  started_at?: string;              // ISO 真实「开始会议」墙钟（时间脊原点：会中每笔的相对时刻 = abs_timestamp − started_at；会后与飞书录音对轴的 t0）
  ended_at?: string;                // ISO 真实「结束会议」墙钟
  material_doc_ids: string[];       // 可能有用的文件（指向 docs/pdf_blobs 的 document_id）
  summary?: string;                 // 会后「思路总结」（AI 综合，先空）
  created_at: string;
  updated_at: string;
}
