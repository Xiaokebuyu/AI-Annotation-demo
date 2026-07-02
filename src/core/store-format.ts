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
import type { CaptureSurface, HMP, InferenceView, MarkFeatureType, NormBBox, OverlayState, PipelineStage, ScreenOverlay, StrokeCoordSpace, StrokePoint, SurfaceBBox } from './contracts';
import type { ReflowBlock } from '../surface/reflow';
import type { RawRef } from './bedrock';

export const STORE_VERSION = '2'; // 1→2：strokes/overlays 出 docs 进 marks/ai_turns 账本（干净断裂，旧 docs 弃）
export const DB_VERSION = 10;     // v9→v10：canonical_entities（存储原生跨文档实体注册表·store.ts ① 基线幂等建）。任何升级都自愈缺表。升级走幂等基线 + 阶梯迁移（store.ts openDB），老数据不丢
export type MarkEntrySchemaVersion = '3' | '4' | '5';
export const MARK_ENTRY_SCHEMA_VERSION: MarkEntrySchemaVersion = '5'; // v4→v5：reader_px 笔迹可选带 reader_layout_id（引用阅读页视觉行布局快照，导出复现文字背景）。additive·不 bump STORE_VERSION·旧条目缺字段即可。

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

/** 阅读页某一视觉行的文字（reader_px 坐标·SVG baseline y）——导出时和 reader_px 笔迹同源合成"文字背景"。 */
export interface PersistedReaderTextRun {
  text: string;
  x: number;
  y: number; // SVG baseline，reader_px
  w: number;
  h: number;
  font_size: number;
  font_family?: string;
  font_weight?: string;
  font_style?: string;
  fill?: string;
  block_id?: string;
}

/** 一页重排 reader 视图的视觉行布局快照：reader_px 笔迹靠它复现"阅读当时看到的文字"（笔迹叠在文字上）。 */
export interface PersistedReaderLayoutSnapshot {
  schema: 'inkloop.reader_layout.v1';
  layout_id: string;         // 内容+尺寸确定性 hash；同布局同 id·避免重复存
  page_index: number;
  page_id: string;
  capture_surface: 'reader';
  coord_space: 'reader_px';
  width: number;
  height: number;
  style_fingerprint: string; // 宽度/字体/引擎/分页 关键 CSS 指纹（判布局是否可比）
  reflow_engine?: string | null;
  text_runs: PersistedReaderTextRun[];
  updated_at: string;
}

/** 一笔的低成本序列：canonical 点串 + 工具（redraw 据此还原原貌、保多笔保真）。 */
export interface PersistedStroke {
  tool: 'pen' | 'aipen' | 'highlighter' | 'eraser' | 'hand';
  points: StrokePoint[];              // canonical page_norm 点串（跨面锚定/原版重绘）；旧数据只有这一套。
  coord_space?: StrokeCoordSpace;     // points 的坐标系；缺省 page_norm。
  capture_surface?: CaptureSurface;   // 该笔实际落笔 surface；缺省 page。
  surface_points?: StrokePoint[];     // 用户落笔 surface 的原始点串；reader 落笔=reader_px，不拿来当 PDF 坐标。
  surface_coord_space?: StrokeCoordSpace;
  surface_bbox?: SurfaceBBox;         // surface_points bbox；reader_px 时这是内容 px，不夹 [0,1]。
  reader_layout_id?: string;          // reader_px 笔迹对应的阅读页视觉行布局快照 id；旧数据缺=导出无文字背景。
  anchor_runs?: string[];           // 位置真相锚（逐笔）：该笔落笔时命中重排块的 source run ids → 重投影时各笔认各自的块（多笔手写跨段不被拉拢/塌缩·恒等）。仅重排落笔有；原版/老条目缺=undefined
  coord_px_per_norm?: number;       // 仅重排块本地投影：1 归一化单位 = 多少 reader px。有值=points 用块本地 uniform scale（在界）；缺=老 pageCss 除数（可越界近似）——重投影按此选逆运算，round-trip 各自自洽。
}

/** docs 的页缓存：只剩重排结构 + 图解（派生缓存）。strokes/overlays 已迁出到 marks/ai_turns 账本。 */
export interface PersistedPage {
  page_index: number;
  reflow: ReflowBlock[] | null;   // 预排版结构（null = 未排版）
  reflow_engine: string | null;   // 产出该重排的引擎（切引擎需重排）
  reader_layouts?: Record<string, PersistedReaderLayoutSnapshot>; // key=layout_id；同布局覆盖·不随每笔膨胀（派生缓存）
  current_reader_layout_id?: string;                              // 最近一次稳定布局的 id（落笔时给新笔引用）
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

/** 一条账本条目对某 canonical 实体的关联（存储原生拓扑真相源：mark/ai_turn 是成员关系唯一来源，KO 不持久化不能存这个）。 */
export interface LedgerEntityRef {
  entity_id: string;                                    // PersistedEntity.entity_id（归一化 slug）
  display?: string;                                      // 声明当时的 UI 名称快照（entity 改名不影响历史 refs 语义）
  source: 'declared' | 'llm_suggested' | 'imported';     // declared=采集时用户声明；llm_suggested=后台 suggester 写回；imported=外部导入
  confidence?: number;                                   // 仅 llm_suggested 有意义
  review_state?: 'suggested' | 'accepted' | 'rejected';  // 仅 llm_suggested 有意义；用户未过一遍时缺省视为 suggested
}

/** 条目公共基字段（marks / ai_turns 共用）。 */
export interface BaseEntry {
  entry_id: string;     // shortId('ent')
  document_id: string;
  page_id: string;      // 'pg_{hash8}_{idx}'，规范键
  page_index: number;
  seq: number;          // 每书单调递增（Date.now() 起跳，跨 reload 仍增），驱动折叠/水位线
  created_at: string;   // ISO 墙钟
  entity_refs?: LedgerEntityRef[]; // 存储原生拓扑：本条关联到的跨文档实体（builder 据此确定性投影成员边，零 LLM）
  topic_refs?: LedgerEntityRef[];  // 同 entity_refs，语义上更松散的主题标注（渲染/过滤可分开处理）
  source_created_at?: string;      // 仅当本条是"补写 refs 的 revision"（append 同 mark_id/overlay_id 新条目、只改 refs 不改内容）时设置：
                                    // 记录被补写对象的原始语义创建时间，供 builder 投影 KO.created_at 时使用（≠本条 created_at）。
                                    // 若不设，builder 直接用 created_at；这样内容不变的补写不会让既有 KO 的 content_hash 漂移。
}

/** 页账本条目 = 一次组装手势（marks store）。is_tombstone=true 表示擦除携同 mark_id。 */
export interface PersistedMark extends BaseEntry {
  schema_version?: MarkEntrySchemaVersion; // 老条目缺=v2；v3=双 surface 取证；v4=新增可选 entity_refs/topic_refs。新条目写 MARK_ENTRY_SCHEMA_VERSION。
  mark_id: string;                  // = 代表 event 的 event_id，跨 reload 稳定引用
  strokes: PersistedStroke[];       // 构成笔（tool+points），redraw 保真（不存合并点）
  bbox: NormBBox;                   // union bbox
  coord_space?: StrokeCoordSpace;    // bbox/strokes.points 的坐标系；缺省 page_norm。
  capture_surface?: CaptureSurface;  // 用户实际落笔 surface；缺省 page。
  surface_bbox?: SurfaceBBox;        // 用户落笔 surface 的 union bbox；reader_px 时是内容 px。
  surface_coord_space?: StrokeCoordSpace;
  reader_layout_id?: string;         // mark 级当前 reader 布局快照 id；逐笔精确值仍在 strokes[].reader_layout_id。
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
  ai_eligible?: boolean;           // 笔触划分（Phase P）：是否进 AI 管线。false=普通笔/荧光纯内容（不识别/不答问/不进 pending session）；true/缺=AI 笔触或旧自动判意（reload 仍可综合）。getPendingMarks 据此排除内容笔
  origin?: 'pen' | 'ai_pen' | 'highlighter' | 'auto'; // 来源：普通笔 / AI 笔 / 荧光 / 自动判意模式。诊断+将来策略用；缺=旧条目
  raw_ref?: RawRef;                // → 基岩录像的对应段+seq 区间（仅 features/settings.bedrock 开时有；老条目缺=undefined）
  reflow_anchor_runs?: string[];   // 位置真相锚：重排面落笔时所在重排块的 source run ids → 重投影时认它定段（恒等·不靠坐标猜）。仅重排落笔有；原版落笔/老条目缺=undefined（退 nearestBlockByBbox 近似）
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

/* ── canonical_entities（存储原生拓扑）───────────────────────────────────────
 * 跨文档实体/主题注册表（Tier2 canonical）。与 marks/ai_turns 不同：这是**可更新
 * registry**，不是 append-only 账本——改名/合并直接 put。成员关系的真相仍在
 * marks/ai_turns 的 entity_refs/topic_refs（见 BaseEntry），这里只登记实体本身。
 * builder 导出投影时读 entities + 账本 refs，纯确定性、零 LLM。 */

export type PersistedEntityKind = 'entity' | 'topic' | 'person' | 'org' | 'project' | 'place' | 'concept';

export interface PersistedEntityProvenanceItem {
  source: 'user' | 'llm_suggestion' | 'import' | 'merge';
  document_id?: string;
  entry_id?: string;    // 触发本条 provenance 的 mark/ai_turn entry_id
  confidence?: number;  // 仅 llm_suggestion 有意义
  created_at: string;
}

/** 一个跨文档实体（entity_id 稳定不变；display/aliases/status 可改）。 */
export interface PersistedEntity {
  entity_id: string;       // 归一化 slug（normalizeEntityId(display)），稳定身份，跨 reload/设备不变
  normalized_key: string;  // 当前等于 entity_id；单独存以便未来 entity_id 与归一键分离时不破坏兼容
  display: string;         // 用户可见名称（可改）
  kind: PersistedEntityKind;
  aliases?: string[];
  provenance: {
    document_ids: string[];                    // 出现过的文档（去重·不驱动成员关系，只供 UI/后台参考）
    entries: PersistedEntityProvenanceItem[];
  };
  status?: 'active' | 'merged' | 'deprecated';  // 缺省 active
  merged_into?: string;                          // status='merged' 时指向目标 entity_id；builder 投影时按此归并，不改历史 refs
  created_at: string;
  updated_at: string;
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

/** L5：panel 飞书会议五要素总结（「会议讲了什么」·和本地手写 recap「我何时写了什么」互补）。 */
export interface PanelMeetingSummaryFive {
  conclusions: string[];
  action_items: Array<{ task: string; owner: string; due?: string; evidence?: string }>;
  risks: string[];
  open_questions: string[];
  next_steps: string[];
}
export interface PanelMeetingSummaryRecord {
  minute_token: string;
  meeting_id?: string;
  topic?: string;
  generated_at: number;        // epoch ms
  model?: string;
  summary: PanelMeetingSummaryFive;
}

/**
 * 妙记文档（docx 导出形态，非 `/minutes/<token>` 卡片链接）挂到会议的「链接型资料」。
 * 不塞进 material_doc_ids——那个字段的 UI/导出全链路都假定它指向已入库的 PersistedDoc（listBooks() 能查到），
 * 链接型资料一开始就不是这种（可能一直没有可读内容，只是个 url）。link_only 是最低可用态：先把链接本身挂上，
 * 拉标题/导出 PDF 都是可选的后续增强——用户手动点「导出 PDF」成功后，pdf_doc_id 指向的才是一个真正的 material_doc_ids 条目。
 */
export interface PersistedMeetingMaterialLink {
  link_id: string;                 // 'mtglink_'+meetingId+'_'+token（稳定 id，见 feishu-materials.ts materialLinkId）
  kind: 'feishu_docx';             // 目前只支持这一种；未来若支持 wiki 链接等可扩展
  url: string;                     // 完整原链接（点开跳转飞书用）
  token: string;                   // /docx/<token> 的 token
  title?: string;                  // 拉到 meta 后回填的真实标题；没有则显示链接本身
  source_chat_id?: string;         // 来源群（若是从群消息里识别到的）
  source_message_id?: string;
  source_create_time?: string;     // 飞书消息 create_time（epoch ms 字符串）
  attached_at: string;             // ISO：挂上这条资料的时刻
  updated_at?: string;
  status?: 'link_only' | 'metadata_ready' | 'pdf_ready' | 'permission_denied' | 'failed';
  pdf_doc_id?: string;             // 用户手动「导出 PDF」成功后，对应 material_doc_ids 里的那个 document_id
  error?: string;                  // 上一次尝试失败的原因（导出 PDF 403/超时等）
}

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
  material_links?: PersistedMeetingMaterialLink[]; // 链接型资料（妙记 docx 等·不强求可批注·见 PersistedMeetingMaterialLink）
  summary?: string;                 // 会后「思路总结」（AI 综合，先空）
  // ── WS2-C 飞书妙记对照（optional·零迁移；近似对照非精确对齐·见 integration/panel-feishu）──
  feishu_meeting_id?: string;       // 关联的飞书 VC 会议 id
  feishu_meeting_no?: string;       // 9 位会议号
  feishu_topic?: string;            // 关联的飞书会议主题（卡片显示·便于用户核对没关错）
  feishu_minute_token?: string;     // 妙记 token（拉转写用）
  feishu_minute_url?: string;       // 妙记页 url
  panel_meeting_start?: number;     // panel 会议 start_time（epoch ms·≠录音起点·保留 raw 供核对/兜底）
  vc_meeting_start_t0?: number;     // vc all_meeting_started.start_time（epoch ms·会议开始·L1 真 t0 来源）
  feishu_recording_t0?: number;     // 真录音 t0 绝对墙钟（epoch ms）；旧数据可能装过 panel start 近似（兼容读·见 recapT0）
  t0_source?: 'local_enter' | 'panel_start' | 'vc_event' | 'recording_event' | 'manual'; // t0 来源（会中用会议 t0·会后优先录音 t0·诚实标注）
  align_offset_ms?: number;         // 用户/启发式微调（cueAbs = t0 + offset + cue 相对）
  align_state?: 'uncalibrated' | 'approx' | 'event' | 'manual'; // 校准状态（event=会议事件 t0·录音残差未消除·UI 明示防假精确）
  feishu_match_confirmed_at?: string; // 用户确认关联的时刻
  summary_generated_at?: string;    // summary 生成时刻（防 stale）
  summary_source?: { feishu_minute_token?: string; align_offset_ms?: number; mark_count: number; cue_count: number; transcript_truncated?: boolean; used_cue_count?: number };
  // ── L5 panel 总结缓存（recap 顶部显示·离线不丢·optional 零迁移）──
  panel_summary?: PanelMeetingSummaryRecord;
  panel_summary_fetched_at?: string;
  panel_summary_status?: 'ready' | 'not_generated' | 'missing_minute' | 'not_found' | 'failed';
  panel_summary_unread?: boolean;   // 总结由 summary_ready 事件后台到达、用户还没进 recap 看过（home/detail 提醒用·进 recap 即清）
  live_unread?: boolean;            // 飞书 started 事件把这场会议推成 live、用户还没点开看过（M7·nav 徽标+home 顶部提醒用·openMeeting 即清）
  exported_at?: string;             // ISO：上次成功「导出到 Obsidian」的时刻（阶段⑤·recap 显示「上次导出」用）
  // ── 日程会议（日历来源）+ 实时归群（optional 零迁移）──
  source_kind?: 'calendar' | 'vc' | 'manual'; // 来源：calendar=飞书日历日程预占位 · vc=panel VC started 事件 · manual=手建/模拟（缺省按已有字段推断）
  feishu_calendar_event_id?: string;          // 日历 event_id（日程落库幂等键·防重复建）
  calendar_meeting_no?: string;               // 从日历 vchat.meeting_url 解析的会议号（桥接 panel started.meeting_no 实时归群）
  group_claimed_at?: string;                  // 用户手动认领群的时刻（区别 group_ids 自动归·认领映射来源·UI 显示「已认领」）
  created_at: string;
  updated_at: string;
}

/** 飞书妙记转写缓存（meeting_minutes store·会后离线复盘不丢转写）。按 minute_token 主键。 */
export interface PersistedMeetingMinute {
  minute_token: string;
  meeting_id?: string;              // 关联的本地会议（便利反查）
  srt: string;                      // 原始 SRT 文本
  title?: string;
  duration_ms?: number;
  fetched_at: string;               // ISO 拉取时刻
}
