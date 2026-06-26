/**
 * 合成聊天 surface —— 徐智强 step① 的"App 主动提交 SurfaceIndex"路径（我们自己的 app 原生吐对象表）。
 *
 * 用结构化数据渲染聊天气泡到 #page-layer。因为是我们渲染的，每个对象的 type/role/bbox/text 本就已知，
 * 直接 emit 一份真 SurfaceIndex——不靠云端视觉反推截图。下游 ink/pipeline/target 全部复用 PDF 路径那套。
 *
 * 关键设计：embedded_image 气泡**故意不交出文字**（SurfaceObject.text 留空），逼出 step⑤ 局部 OCR；
 * 气泡之间 + 底部留 blank_region，在那写字会命中 self_content（step⑥）。
 */
import type { NormBBox, SurfaceObject } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import { bus, state, getActiveContext } from '../app/state';
import { setPageSize, GUTTER_W } from '../core/transform';
import { makeSurfaceIndex } from '../core/surface-index';
import { trace } from '../core/trace';

interface ChatMsg {
  role: 'user' | 'agent';
  text?: string;
  /** embedded_image 气泡：app 只知道这是一张图，不知道里面写了什么（caption 是 UI 标签，body 仅画成像素）。 */
  image?: { caption: string; body: string };
}

const SAMPLE: ChatMsg[] = [
  { role: 'user', text: '我想退换货怎么办' },
  { role: 'agent', text: '我帮您查一下订单号～请把订单号发我' },
  { role: 'user', text: '订单号是 880176642' },
  { role: 'agent', image: { caption: '物流单据', body: '已签收 2026-06-15 顺丰 SF1234567' } },
  { role: 'user', text: '好的，那退货地址是哪里' },
];

const W = 460;          // surface 逻辑宽（CSS px）
const PAD = 18;         // 外边距
const PAD_IN = 10;      // 气泡内边距
const GAP = 16;         // 气泡纵向间隔
const LINE_H = 22;
const FONT = 15;
const BUBBLE_MAXW = 0.66;
const IMG_W = 0.52, IMG_H = 74;
const TAIL_BLANK = 96;  // 底部留白写字区（self_content 用）

type Item =
  | { kind: 'msg'; m: ChatMsg; x: number; y: number; w: number; h: number; lines: string[] }
  | { kind: 'image'; m: ChatMsg; x: number; y: number; w: number; h: number };

/** CJK 友好换行：无空格时按字断行。 */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    const test = cur + ch;
    if (ctx.measureText(test).width > maxW && cur) { lines.push(cur); cur = ch; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** 载入示例聊天：渲染气泡 + 原生构建并 emit SurfaceIndex。 */
export function renderChatSurface(): void {
  // B1：示例聊天是阅读态 demo，直写 state.* 会落到「当前激活实例」。若正在会议里点它，会污染会议实例
  // （documentId 被改成 chat_sample、账本归属错乱）。故只在主阅读实例载入。
  // （真正把 chat 做成独立 surface 实例 = C1 的 SurfaceContext 泛化。）
  if (getActiveContext().role !== 'reader') return;

  const pageCv = document.getElementById('page-layer') as HTMLCanvasElement | null;
  const inkCv = document.getElementById('ink-layer') as HTMLCanvasElement | null;
  const stage = document.getElementById('stage') as HTMLElement | null;
  if (!pageCv || !inkCv || !stage) return;

  const dpr = window.devicePixelRatio || 1;
  let ctx = pageCv.getContext('2d')!;
  ctx.font = `${FONT}px -apple-system, system-ui, sans-serif`;

  // ① 布局（先量后画）：自上而下排气泡，累加高度
  const items: Item[] = [];
  let y = PAD;
  for (const m of SAMPLE) {
    if (m.image) {
      const w = Math.round(W * IMG_W);
      items.push({ kind: 'image', m, x: PAD, y, w, h: IMG_H });
      y += IMG_H + GAP;
    } else {
      const maxInner = Math.round(W * BUBBLE_MAXW) - 2 * PAD_IN;
      const lines = wrap(ctx, m.text!, maxInner);
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const bw = Math.ceil(tw) + 2 * PAD_IN;
      const bh = lines.length * LINE_H + 2 * PAD_IN;
      const x = m.role === 'user' ? (W - PAD - bw) : PAD;
      items.push({ kind: 'msg', m, x, y, w: bw, h: bh, lines });
      y += bh + GAP;
    }
  }
  const H = Math.round(y - GAP + PAD + TAIL_BLANK);

  // ② 定尺寸（resize 会清空 context，故之后重设 transform/font）
  for (const cv of [pageCv, inkCv]) {
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }
  stage.style.width = (W + GUTTER_W) + 'px';
  stage.style.height = H + 'px';
  stage.style.setProperty('--page-w', W + 'px');
  setPageSize(W, H);

  // ③ 绘制
  ctx = pageCv.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#fbfaf7'; ctx.fillRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  for (const it of items) {
    if (it.kind === 'image') {
      ctx.fillStyle = '#eef1f4'; roundRect(ctx, it.x, it.y, it.w, it.h, 8); ctx.fill();
      ctx.strokeStyle = '#c9cfd6'; ctx.lineWidth = 1; roundRect(ctx, it.x, it.y, it.w, it.h, 8); ctx.stroke();
      ctx.fillStyle = '#8a9099'; ctx.font = `11px system-ui, sans-serif`;
      ctx.fillText('🖼 ' + it.m.image!.caption, it.x + 10, it.y + 8);
      ctx.fillStyle = '#3a3f45'; ctx.font = `13px system-ui, sans-serif`;
      ctx.fillText(it.m.image!.body, it.x + 10, it.y + 30); // 仅像素，SurfaceObject 不交出此文字
    } else {
      ctx.fillStyle = it.m.role === 'user' ? '#d6ebff' : '#ececec';
      roundRect(ctx, it.x, it.y, it.w, it.h, 12); ctx.fill();
      ctx.fillStyle = '#1c1c1c'; ctx.font = `${FONT}px -apple-system, system-ui, sans-serif`;
      it.lines.forEach((ln, i) => ctx.fillText(ln, it.x + PAD_IN, it.y + PAD_IN + i * LINE_H));
    }
  }

  // ④ 原生构建 SurfaceIndex：气泡→chat_message、图→image(无text)、空隙/底部→blank_region
  const norm = (x: number, yy: number, w: number, h: number): NormBBox => [x / W, yy / H, w / W, h / H];
  const objects: SurfaceObject[] = [];
  let prevBottom = 0;
  const pushBlank = (top: number, bottom: number) => {
    if (bottom - top > 10) objects.push({ id: `blank_${objects.length}`, type: 'blank_region', bbox: norm(PAD, top, W - 2 * PAD, bottom - top), source: 'structure' });
  };
  for (const it of items) {
    pushBlank(prevBottom, it.y);
    if (it.kind === 'image') {
      objects.push({ id: `img_${objects.length}`, type: 'image', role: 'embedded_image', bbox: norm(it.x, it.y, it.w, it.h), source: 'structure' });
    } else {
      objects.push({ id: `msg_${objects.length}`, type: 'chat_message', role: it.m.role, text: it.m.text, bbox: norm(it.x, it.y, it.w, it.h), source: 'structure' });
    }
    prevBottom = it.y + it.h;
  }
  pushBlank(prevBottom, H); // 底部留白写字区

  // ⑤ 写入 state（surfaceType=chat；textBlocks/imageRegions 为兼容垫片，保 pageText 等下游可用）
  state.surfaceType = 'chat';
  state.fileHash = 'chat-sample';
  state.documentId = 'chat_sample';
  state.fileName = '示例聊天';
  state.pageCount = 1;
  state.pageIndex = 0;
  state.strokesByPage.clear();
  state.pageId = 'chat_sample_0';
  state.pageRecord = { page_id: 'chat_sample_0', document_id: 'chat_sample', page_index: 0, width: W, height: H, unit: 'pt', rotation: 0, render_dpi: 96, version: SCHEMA_VERSION };
  state.overlays = [];
  state.surfaceIndex = makeSurfaceIndex('chat_sample_0', 'chat', objects);
  state.textBlocks = objects
    .filter((o) => o.type === 'chat_message' && o.text)
    .map((o) => ({ id: o.id, text: o.text!, bbox: o.bbox, confidence: 1, language: 'auto' }));
  state.imageRegions = objects.filter((o) => o.type === 'image').map((o) => o.bbox);

  bus.emit('document:loaded');
  bus.emit('page:rendered');
  trace('SurfaceIndex', state.surfaceIndex as unknown as Record<string, unknown>);
  bus.emit('surface:indexed', state.surfaceIndex);
}
