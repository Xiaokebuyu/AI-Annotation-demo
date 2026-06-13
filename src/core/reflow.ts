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
import type { NormBBox, OcrTextBlock } from './contracts';

/** 确定性块 id：同页同引擎重排出同样的 id → 缩放/重渲后行内注不丢锚。 */
function blockId(text: string, index: number): string {
  let h = 0;
  for (let k = 0; k < text.length; k++) h = (h * 31 + text.charCodeAt(k)) | 0;
  return `rfl_${index}_${(h >>> 0).toString(36)}`;
}

export type ReflowBlockType = 'heading' | 'para';

export interface ReflowBlock {
  id: string;
  type: ReflowBlockType;
  level: number;       // heading：1–3；para：0
  text: string;
  source: NormBBox;    // 原页归一化 bbox 并集
}

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

  // 聚段 + 认标题
  const out: ReflowBlock[] = [];
  let para: Line[] = [];
  const flush = () => {
    if (!para.length) return;
    const text = joinRuns(para.map((l) => joinRuns(l.runs.map((r) => r.text))));
    out.push({ id: blockId(text, out.length), type: 'para', level: 0, text, source: unionBBox(para.flatMap((l) => l.runs)) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const ratio = ln.size / bodyFont;
    const isHeading = ratio >= 1.22 && ln.runs.length > 0;
    if (isHeading) {
      flush();
      const level = ratio >= 1.7 ? 1 : ratio >= 1.4 ? 2 : 3;
      const htext = joinRuns(ln.runs.map((r) => r.text));
      out.push({ id: blockId(htext, out.length), type: 'heading', level, text: htext, source: unionBBox(ln.runs) });
      continue;
    }
    const prev = lines[i - 1];
    const gap = prev ? ln.yTop - prev.yBot : 0;
    if (para.length && gap > 1.3 * bodyFont) flush(); // 段间距 → 断段
    para.push(ln);
  }
  flush();
  return out;
}
