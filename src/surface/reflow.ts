/**
 * 本地启发式重排（tier-1，纯几何，无 DOM）。
 *
 * 输入：页面文本层 runs（OcrTextBlock，归一化 bbox + 文字）。
 * 输出：有序的 ReflowBlock —— 干净阅读流（标题/段落），每块保留它在原页的 bbox 并集，
 *       这条「重排块 ↔ 原页 bbox」映射是保住可追溯（D1 归一化坐标契约）的关键。
 *
 * 处理得了：单栏正文的 行→段→标题，剥页眉页脚页码。
 * 处理不好（留给模型版/B 组 VLM 文档解析）：多栏、表格、图片、公式。
 */
import type { NormBBox, OcrTextBlock } from '../core/contracts';

/** 确定性块 id：同页同引擎重排出同样的 id → 缩放/重渲后行内注不丢锚。 */
export function blockId(text: string, index: number): string {
  let h = 0;
  for (let k = 0; k < text.length; k++) h = (h * 31 + text.charCodeAt(k)) | 0;
  return `rfl_${index}_${(h >>> 0).toString(36)}`;
}

export type ReflowBlockType = 'heading' | 'para' | 'list';

export interface ReflowBlock {
  id: string;
  type: ReflowBlockType;
  level: number;       // heading：1–3；para/list：0
  text: string;
  source: NormBBox;    // 原页归一化 bbox 并集
  items?: string[];    // list：各列表项文本（已去掉前缀符号）
  ordered?: boolean;   // list：有序(1.2.3 / 一二三)还是无序(•-*)
  // 跨视图对象桥：构成本块的 run id（OcrTextBlock.id，如 tl_3）。字符对象 = 各 run 的 ${runId}_*。
  // 标注锚在字符对象上 → 经此把"在哪个块"算出来，原版页/重排页共用一套锚。可选=兼容旧缓存。
  sourceRunIds?: string[];
  anchorUnsafe?: boolean; // true=bbox 系模型估算(VLM 重写)，非文本层，跨视图映射不可靠
}

/** 列表项前缀：项目符号 / 数字 / 圆圈数字 / 中文数字（行首 + 其后空白）。 */
const LIST_RE = /^\s*([•·‣▪◦●○]|[-–—*]|\(?\d{1,2}[.)、]|[①-⑳]|[一二三四五六七八九十]{1,3}[、.])\s+/;

interface Line {
  runs: OcrTextBlock[];
  yMid: number;
  yTop: number;
  yBot: number;
  size: number;        // 行字号代理 = runs 高度中位数
}

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

const isCJK = (c: string): boolean => /[　-鿿＀-￯]/.test(c);

/** 同一行内多个 run 按 x 拼接：中日韩之间不加空格，西文之间补空格。 */
function joinRuns(texts: string[]): string {
  let out = '';
  for (const raw of texts) {
    const t = raw.trim();
    if (!t) continue;
    if (!out) { out = t; continue; }
    const a = out[out.length - 1], b = t[0];
    out += (isCJK(a) || isCJK(b)) ? t : ' ' + t;
  }
  return out;
}

function unionBBox(runs: OcrTextBlock[]): NormBBox {
  let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
  for (const r of runs) {
    const [x, y, w, h] = r.bbox;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 一"行"：聚合后的 run 行（保 bbox），供 AI 结构重建按行分组、再用 bbox 映射回原页。 */
export interface ReflowLine { id: string; text: string; size: number; bbox: NormBBox; runIds: string[]; }

/**
 * 把 run 聚成行（剥页眉页脚、按 y 聚行、行内按 x 排）。
 * 只到"行"为止——段落边界/标题层级交给 AI（结构重建），避免本地 gap 启发式把多段并成一块。
 */
export function groupLines(blocks: OcrTextBlock[]): ReflowLine[] {
  const runs = blocks.filter((b) => b.text && b.text.trim());
  if (!runs.length) return [];
  const medH = median(runs.map((r) => r.bbox[3])) || 0.012;
  const body = runs.filter((r) => {
    const yc = r.bbox[1] + r.bbox[3] / 2;
    return !((yc < 0.06 || yc > 0.94) && r.text.trim().length <= 6);
  });
  body.sort((a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));
  const lineGap = 0.6 * medH;
  const groups: OcrTextBlock[][] = [];
  let curY = -1;
  for (const r of body) {
    const yc = r.bbox[1] + r.bbox[3] / 2;
    if (groups.length && Math.abs(yc - curY) <= lineGap) groups[groups.length - 1].push(r);
    else { groups.push([r]); curY = yc; }
  }
  return groups.map((g, i) => {
    g.sort((a, b) => a.bbox[0] - b.bbox[0]);
    return { id: 'ln_' + i, text: joinRuns(g.map((r) => r.text)), size: median(g.map((r) => r.bbox[3])), bbox: unionBBox(g), runIds: g.map((r) => r.id) };
  });
}

export function reflowLocal(blocks: OcrTextBlock[]): ReflowBlock[] {
  const runs = blocks.filter((b) => b.text && b.text.trim());
  if (runs.length < 2) return [];

  const medH = median(runs.map((r) => r.bbox[3])) || 0.012;

  // 剥页眉/页脚/页码：贴顶(<0.06)或贴底(>0.94)且很短的 run
  const body = runs.filter((r) => {
    const yc = r.bbox[1] + r.bbox[3] / 2;
    const short = r.text.trim().length <= 6;
    return !((yc < 0.06 || yc > 0.94) && short);
  });

  // 单栏阅读顺序：先 y 后 x（多栏是已知缺口，留给模型版）
  body.sort((a, b) => (a.bbox[1] - b.bbox[1]) || (a.bbox[0] - b.bbox[0]));

  // 聚行：y 中心相近归一行
  const lineGap = 0.6 * medH;
  const lines: Line[] = [];
  for (const r of body) {
    const yc = r.bbox[1] + r.bbox[3] / 2;
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(yc - cur.yMid) <= lineGap) {
      cur.runs.push(r);
    } else {
      lines.push({ runs: [r], yMid: yc, yTop: r.bbox[1], yBot: r.bbox[1] + r.bbox[3], size: r.bbox[3] });
    }
  }
  for (const ln of lines) {
    ln.runs.sort((a, b) => a.bbox[0] - b.bbox[0]);
    ln.yTop = Math.min(...ln.runs.map((r) => r.bbox[1]));
    ln.yBot = Math.max(...ln.runs.map((r) => r.bbox[1] + r.bbox[3]));
    ln.size = median(ln.runs.map((r) => r.bbox[3]));
  }

  const bodyFont = median(lines.map((l) => l.size)) || medH;

  // 聚段 + 认标题 + 认列表
  const out: ReflowBlock[] = [];
  let para: Line[] = [];
  let listLines: Line[] = [];
  let listItems: string[] = [];
  let listOrdered = false;
  let listMarkerX = 0;

  const flushPara = () => {
    if (!para.length) return;
    const text = joinRuns(para.map((l) => joinRuns(l.runs.map((r) => r.text))));
    const runs = para.flatMap((l) => l.runs);
    out.push({ id: blockId(text, out.length), type: 'para', level: 0, text, source: unionBBox(runs), sourceRunIds: runs.map((r) => r.id) });
    para = [];
  };
  const flushList = () => {
    if (!listItems.length) return;
    const text = listItems.join('\n');
    const runs = listLines.flatMap((l) => l.runs);
    out.push({ id: blockId(text, out.length), type: 'list', level: 0, text, items: listItems.slice(), ordered: listOrdered, source: unionBBox(runs), sourceRunIds: runs.map((r) => r.id) });
    listItems = []; listLines = []; listOrdered = false;
  };
  const flushAll = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const lineText = joinRuns(ln.runs.map((r) => r.text));
    const ratio = ln.size / bodyFont;
    const isHeading = ratio >= 1.22 && ln.runs.length > 0;
    if (isHeading) {
      flushAll();
      const level = ratio >= 1.7 ? 1 : ratio >= 1.4 ? 2 : 3;
      out.push({ id: blockId(lineText, out.length), type: 'heading', level, text: lineText, source: unionBBox(ln.runs), sourceRunIds: ln.runs.map((r) => r.id) });
      continue;
    }
    // 列表项：行首是项目符号/编号
    const m = lineText.match(LIST_RE);
    if (m) {
      flushPara();
      const ordered = /[\d①-⑳一二三四五六七八九十]/.test(m[1]);
      if (listItems.length && ordered !== listOrdered) flushList(); // 有序/无序切换 → 断开
      if (!listItems.length) { listOrdered = ordered; listMarkerX = ln.runs[0].bbox[0]; }
      listItems.push(lineText.slice(m[0].length).trim());
      listLines.push(ln);
      continue;
    }
    // 在列表中且本行缩进过 marker（悬挂续行）→ 接到上一项；否则结束列表
    if (listItems.length) {
      const prevBot = listLines[listLines.length - 1].yBot;
      if (ln.runs[0].bbox[0] > listMarkerX + 0.012 && (ln.yTop - prevBot) < 0.9 * bodyFont) {
        listItems[listItems.length - 1] += ' ' + lineText;
        listLines.push(ln);
        continue;
      }
      flushList();
    }
    const prev = lines[i - 1];
    const gap = prev ? ln.yTop - prev.yBot : 0;
    if (para.length && gap > 1.3 * bodyFont) flushPara(); // 段间距 → 断段
    para.push(ln);
  }
  flushAll();
  return out;
}
