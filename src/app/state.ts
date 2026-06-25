import type { HMP, NormBBox, OcrTextBlock, PDFPageRecord, ScreenOverlay, StrokePoint, SurfaceIndex } from '../core/contracts';
import { ReaderContext } from './reader-context';

type Handler = (...args: unknown[]) => void;

class Bus {
  private handlers = new Map<string, Set<Handler>>();
  on(event: string, fn: Handler): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    this.handlers.get(event)?.forEach((fn) => fn(...args));
  }
}

/**
 * 事件总线。约定的事件：
 *  'document:loaded'      文档导入完成
 *  'page:rendered'        页面渲染完成（含缩放重渲）
 *  'overlay:add' (o)      新 overlay 产生
 *  'overlay:state' (o)    overlay 状态变化（接受/编辑/忽略）
 *  'overlay:remove' (id)  overlay 被移除（如综述被新一轮综合替换）
 *  'settings:changed'     行为设置变化（落点/各行为开关）
 *  'anchor:focus' (id)    请求高亮某个锚点
 *  'card:focus' (id)      请求滚动到某张卡片
 *  'trace' (kind, obj)    新 trace 记录
 *  'metrics'              延迟/计数更新
 *  'tool' (tool)          工具切换
 */
export const bus = new Bus();

export type Tool = 'pen' | 'highlighter' | 'eraser' | 'hand';

/** AI 输出落点：右侧留白 / 贴正文浮动。 */
export type Placement = 'margin' | 'inline';

/** 阅读面：原版 PDF / 重排 reader。 */
export type ViewMode = 'page' | 'reader';

/**
 * 开放式行为设置 —— 每条行为独立可启停，可任意组合（非二选一模式）。
 * 以后新增符号语法（箭头=建立联系、波浪线=存疑…）只需再加一条，不动其它。
 */
export interface Settings {
  placement: Placement;
  viewMode: ViewMode;                            // 阅读面：原版 PDF / 重排
  reflowProvider: string;                        // 重排引擎：local / llm
  reflowModel: string;                           // 重排专用模型（快·结构任务）：默认 gemini-3.1-flash-lite，独立于 inferModel
  reflowEager: boolean;                          // 急算开关(默认关·留给端侧)：渲染即后台 AI 重排缓存 → AI 上下文用真实阅读序("重排前置")
  // 预处理：导入后台预排版前 reflowPages 页（封顶；reflowEnabled 默认关，需 dev 面板手动开）
  preprocess: { reflowEnabled: boolean; reflowPages: number };
  //   enabled: 手势响应总开关；idleSeconds: 长停顿(无新笔)多少秒触发整段 session 综合回复
  //   （v3 主线，默认 90=~1.5min；可在 __inkloop.settings 调小做冒烟测试）
  gesture: { enabled: boolean; idleSeconds?: number };
  // 推理模型：按前缀路由渠道——kimi*→moonshot；claude/gpt/gemini*→DMX。默认 sonnet-4-6。
  // （无状态端点：识别/答问/重排走各 /api/* 端点；跨标注连贯交 chat/ 每本书 buffer。）
  inferModel: string;
  // 识别分类器(/api/interpret)、上下文分类器(/api/classify-context)可各自单独选模型(A/B 评估用)；
  // 空字符串 = 继承 inferModel。
  interpretModel: string;
  classifyModel: string;
  // 是否把合成图(墨迹叠原文)送给理解模型。**合成图非徐智强方案**——他的路线靠 HMP 取证事实
  //（命中原文 + text_hint）让 AI 理解，不靠截图。默认 false=纯徐路线验证；dev 控制台可临时 true 做 A/B。
  sendMarkImage: boolean;
  // dev 可视化叠层：在页面上画 SurfaceIndex 对象 bbox + 命中高亮 + 右上角 HMP 浮窗（精度/粒度诊断）。默认关。
  devOverlay: boolean;
  // dev：手写时实时画出当前"组装区域"——正在聚拢的那块(实框) + "附近"判定边界(虚框)。看连续手写聚成一团/何时另起。
  showRegion: boolean;
  // dev：会话提交后，把"内容关联的标注"（标注图里空间/语义相连的一组）用紫色虚框圈起来。看哪些标注被当成一组。
  showRelations: boolean;
}

export const settings: Settings = {
  placement: 'margin',
  viewMode: 'page',
  reflowProvider: 'ai', // 主线：AI 结构重建（文本驱动·保 bbox）
  reflowModel: 'gemini-3.1-flash-lite', // 重排走快模型（结构任务·延迟敏感·质量门槛低）。新字段→所有人即时生效。
  reflowEager: false,   // 默认关：现在不为 AI 上下文烧 token；端侧重排模型上了再默认开 = 真"重排前置"。
  preprocess: { reflowEnabled: false, reflowPages: 5 },
  gesture: { enabled: true, idleSeconds: 90 },
  inferModel: 'claude-sonnet-4-6', // 默认推理+识别模型：sonnet-4.6（DMX，中文手写实测准）。recognizeInk/chat 都随它。
  //   注：旧用户 localStorage 里存了别的会覆盖此默认——要用 sonnet 需在 dev 面板「推理模型」选一次或清 inkloop.settings.v1。
  interpretModel: '', // 识别分类器(/api/interpret)模型；空=继承 inferModel。
  classifyModel: '',  // 上下文分类器(/api/classify-context)模型；空=继承 inferModel。
  sendMarkImage: false, // 默认不送合成图：纯验证徐智强的取证路线（AI 只吃 HMP 事实+整页上下文）。
  devOverlay: false,    // dev bbox 叠层默认关。
  showRegion: true,     // dev 组装区域实时可视：默认开（手写时看受影响区域）。
  showRelations: true,  // dev 关联框：默认开（提交后看哪些标注被判为内容关联的一组）。
};

/** 持久化 dev 旋钮：刷新不丢（免每次手动重设）。模块加载即回填，故所有消费方从一开始就拿到持久值。 */
const PREFS_KEY = 'inkloop.settings.v1';
try {
  const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
  if (saved && typeof saved === 'object') Object.assign(settings, saved); // 缺字段保留默认；多余字段无害
} catch { /* localStorage 不可用/损坏：用默认值 */ }

export function saveSettings(): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(settings)); } catch { /* 忽略 */ }
}

export interface Stroke {
  tool: Tool;
  points: StrokePoint[];
}

export const state = {
  tool: 'pen' as Tool,
  zoom: 1,
  fileName: '',
  fileHash: null as string | null,
  documentId: null as string | null,
  pageCount: 0,
  pageIndex: 0,
  pageId: null as string | null,
  pageRecord: null as PDFPageRecord | null,
  // PDF 文档级元信息：Info 字典(Title/Author/Producer/CreationDate…) + 大纲目录(章节树)。喂重排/AI 排版。
  docMeta: null as Record<string, unknown> | null,
  outline: null as unknown[] | null,
  textBlocks: [] as OcrTextBlock[],
  imageRegions: [] as NormBBox[],   // 本页原 PDF 中的图像区域（归一化 bbox），重排时保留

  // 徐智强「序列语义方案」：显式 SurfaceIndex（step①）+ HMP 取证记录（step④）
  surfaceIndex: null as SurfaceIndex | null, // 当前 surface 的轻量对象表（PDF 路径由 textBlocks/imageRegions 构建）
  lastHmps: [] as HMP[],                       // 最近 ~10 条 HMP 取证记录（dev-drawer 可读）
  surfaceType: 'pdf' as 'pdf' | 'chat' | 'whiteboard', // 当前 surface 类型（PDF 渲染 / 合成聊天 / 空白手写页）

  strokesByPage: new Map<string, Stroke[]>(),
  overlays: [] as ScreenOverlay[],
  inferProvider: 'cloud',
};

/**
 * 方案 B 解耦 Stage 1：`state` 的 16 个「随文档/surface 走」字段委托到「当前激活的 ReaderContext」。
 * tool/zoom/inferProvider 仍是 state 自有属性（属用户的手、非文档）。消费方零改：仍 `state.documentId` 即可。
 * 进/退会议 = setActiveContext 切换激活实例；上面字面量给的初值只为类型推导，运行时被 activeCtx 的同名初值替代（等价）。
 */
let activeCtx = new ReaderContext('__reader__', 'reader');

const DOC_FIELDS = [
  'fileName', 'fileHash', 'documentId', 'pageCount', 'pageIndex', 'pageId', 'pageRecord',
  'docMeta', 'outline', 'textBlocks', 'imageRegions', 'surfaceIndex', 'lastHmps', 'surfaceType',
  'strokesByPage', 'overlays',
] as const;

for (const k of DOC_FIELDS) {
  Object.defineProperty(state, k, {
    get() { return (activeCtx as unknown as Record<string, unknown>)[k]; },
    set(v: unknown) { (activeCtx as unknown as Record<string, unknown>)[k] = v; },
    enumerable: true,
    configurable: true,
  });
}

/** 当前激活的 surface 实例（阅读 / 某个会议）。renderer/console 需直接拿 pdf 等非委托字段时用。 */
export function getActiveContext(): ReaderContext { return activeCtx; }

/** 切换激活实例（进/退会议）。发 'context:switched' 让 main.ts 决定如何重绘（PDF→renderPage / 白板→renderBlankSurface）。 */
export function setActiveContext(ctx: ReaderContext): void {
  activeCtx = ctx;
  bus.emit('context:switched', ctx);
}

export function currentStrokes(): Stroke[] {
  if (!state.pageId) return [];
  if (!state.strokesByPage.has(state.pageId)) state.strokesByPage.set(state.pageId, []);
  return state.strokesByPage.get(state.pageId)!;
}

/** 笔 → 它所属 mark 的 id（组装时 main.ts 填）。擦/撤一笔时据此给整 mark 落 tombstone。 */
export const strokeMarkIds = new WeakMap<Stroke, string>();

export function setTool(tool: Tool): void {
  state.tool = tool;
  bus.emit('tool', tool);
}
