import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { HMP, NormBBox, OcrTextBlock, PDFPageRecord, ScreenOverlay, SurfaceIndex, SurfaceType } from '../core/contracts';
import type { PersistedDoc } from '../core/store-format';
import type { Stroke } from './state';

/** surface 实例的「所属模式」（谁拥有这个 context）。与 surfaceType（article/chat/whiteboard，渲染类型）正交。 */
export type SurfaceRole = 'reader' | 'meeting' | 'diary';

/**
 * 可标注 surface 的「实例上下文」—— 底座层（C1：从 ReaderContext 泛化而来）。
 *
 * 把原本散在全局 `state` 上的「随当前文档/surface 走」的 17 个字段 + renderer 的 `pdf`
 * 收进一个可实例化对象。`阅读` 持一个 readerCtx，每个会议各持一个 meetingCtx，日记将持 diaryCtx；
 * 切模式 = 切换「激活哪个 context」（见 state.ts 的 setActiveContext / 委托）。
 *
 * 单 DOM：一次只渲染一个激活 context。真双 DOM 同屏已弃（用户拍板），但实例隔离仍要正确。
 * 留在全局 `state` 上的 tool/inferProvider（属「用户的手」非文档）不进这里；
 * zoom 属「这本书/这个面读多大」随实例走（B1：退会议切回不再被会议期缩放污染）。
 */
export class SurfaceContext {
  /** 实例标识：主阅读 '__reader__'；会议 'mtg_<meetingId>'。 */
  readonly id: string;
  readonly role: SurfaceRole;

  /** 当前加载的 PDF 文档对象（从 renderer.ts 模块级变量搬入）。切回本 context 免重新 fetch/decode。 */
  pdf: PDFDocumentProxy | null = null;

  /** 本实例的持久化文档（store 的 PersistedDoc：页缓存/阅读位置/水位线）。renderer 载入后挂上，
   *  setActiveContext 切换时据此把 store.current 重指向本实例的文档——根除跨文档串写（P0-4）。白板=null。 */
  storeDoc: PersistedDoc | null = null;

  /** 异步任务代号（P0-5 竞态守卫）：renderPage / 账本恢复 / 文档载入 / AI 会话提交进入时各 ++ 并 capture，
   *  await 后若代号已变或激活实例已换，则丢弃迟到结果不提交，避免 A 的渲染/恢复/回答写进切换后的 B。 */
  renderGeneration = 0;
  restoreGeneration = 0;
  loadGeneration = 0; // 同实例连开两份文档：仅最新一次载入可写 pdf/字段（latest-wins）
  aiGeneration = 0;   // AI 会话提交：回答/旁注/水位线只写发起时的归属实例

  // ── 以下 17 个字段从 app/state.ts 的全局 state 字面量搬出（初值与原默认一致）──
  fileName = '';
  fileHash: string | null = null;
  documentId: string | null = null;
  pageCount = 0;
  pageIndex = 0;
  zoom = 1;                       // 缩放随实例（B1：每本书/每个面各自的阅读缩放，不再全局污染）
  pageId: string | null = null;
  pageRecord: PDFPageRecord | null = null;
  docMeta: Record<string, unknown> | null = null;
  outline: unknown[] | null = null;
  textBlocks: OcrTextBlock[] = [];
  imageRegions: NormBBox[] = [];
  surfaceIndex: SurfaceIndex | null = null;
  lastHmps: HMP[] = [];
  surfaceType: SurfaceType = 'article'; // 渲染/语义类型，统一用 contracts.SurfaceType（article=PDF/有文层）
  strokesByPage: Map<string, Stroke[]> = new Map();
  overlays: ScreenOverlay[] = [];

  constructor(id: string, role: SurfaceRole) {
    this.id = id;
    this.role = role;
  }
}
