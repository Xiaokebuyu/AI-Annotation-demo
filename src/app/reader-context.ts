import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { HMP, NormBBox, OcrTextBlock, PDFPageRecord, ScreenOverlay, SurfaceIndex } from '../core/contracts';
import type { Stroke } from './state';

/**
 * 可标注 surface 的「实例上下文」—— 方案 B 解耦 Stage 1。
 *
 * 把原本散在全局 `state` 上的「随当前文档/surface 走」的 16 个字段 + renderer 的 `pdf`
 * 收进一个可实例化对象。`阅读` 模式持一个 readerCtx，每个会议各持一个 meetingCtx；
 * 进/退会议 = 切换「激活哪个 context」（见 state.ts 的 setActiveContext / 委托）。
 *
 * 单 DOM：一次只渲染一个激活 context（Stage 1）。真双 DOM 同屏是 Stage 2，本类已为其打底。
 * 留在全局 `state` 上的 tool/zoom/inferProvider（属「用户的手」非文档）不进这里。
 */
export class ReaderContext {
  /** 实例标识：主阅读 '__reader__'；会议 'mtg_<meetingId>'。 */
  readonly id: string;
  readonly role: 'reader' | 'meeting';

  /** 当前加载的 PDF 文档对象（从 renderer.ts 模块级变量搬入）。切回本 context 免重新 fetch/decode。 */
  pdf: PDFDocumentProxy | null = null;

  // ── 以下 16 个字段从 app/state.ts 的全局 state 字面量搬出（初值与原默认一致）──
  fileName = '';
  fileHash: string | null = null;
  documentId: string | null = null;
  pageCount = 0;
  pageIndex = 0;
  pageId: string | null = null;
  pageRecord: PDFPageRecord | null = null;
  docMeta: Record<string, unknown> | null = null;
  outline: unknown[] | null = null;
  textBlocks: OcrTextBlock[] = [];
  imageRegions: NormBBox[] = [];
  surfaceIndex: SurfaceIndex | null = null;
  lastHmps: HMP[] = [];
  surfaceType: 'pdf' | 'chat' | 'whiteboard' = 'pdf';
  strokesByPage: Map<string, Stroke[]> = new Map();
  overlays: ScreenOverlay[] = [];

  constructor(id: string, role: 'reader' | 'meeting') {
    this.id = id;
    this.role = role;
  }
}
