import type { OcrTextBlock } from '../core/contracts';
import type { ReflowBlock } from '../core/reflow';
import { reflowLocal } from '../core/reflow';

/**
 * 重排 provider 接缝（跟 ocr.ts / inference.ts 同构）。
 *  - local ：本地启发式，纯几何、离线、保 bbox。
 *  - hybrid：几何打骨架 + 模型逐块精修（纯文字），保 bbox。
 *  - vision：几何打骨架 + 模型**看页面图**重判角色/阅读顺序，保 bbox（多栏/表格更准）。
 * 三者都只重排/精修同一批 id、不合并拆分，所以每块仍认得原页 bbox。
 */
export type ReflowProvider = (blocks: OcrTextBlock[]) => Promise<ReflowBlock[]>;

const local: ReflowProvider = async (blocks) => reflowLocal(blocks);

/** 把当前页 canvas 缩到长边 ≤max 再转 PNG（控 token），失败返回 undefined。 */
function grabPageImage(max = 1280): string | undefined {
  const cv = document.getElementById('page-layer') as HTMLCanvasElement | null;
  if (!cv || !cv.width || !cv.height) return undefined;
  try {
    const scale = Math.min(1, max / Math.max(cv.width, cv.height));
    const w = Math.round(cv.width * scale);
    const h = Math.round(cv.height * scale);
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d')!.drawImage(cv, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  } catch {
    return undefined; // 跨域污染等 → 退回无图
  }
}

/** 几何块交 /api/reflow 精修（可带页面图）；按 id 把原页 bbox 贴回，失败降级用几何。 */
async function refine(base: ReflowBlock[], image?: string): Promise<ReflowBlock[]> {
  if (base.length < 2) return base;
  let refined: Array<{ id: string; type: string; level: number; text: string }>;
  try {
    const resp = await fetch('/api/reflow', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 列表用占位文本送给模型（只让它排序，不让它拆平结构）
      body: JSON.stringify({
        blocks: base.map((b) => ({ id: b.id, type: b.type, text: b.type === 'list' ? `（列表）${(b.items ?? []).join(' / ')}` : b.text })),
        image,
      }),
    });
    if (!resp.ok) return base;
    refined = await resp.json();
    if (!Array.isArray(refined)) return base;
  } catch {
    return base;
  }
  const byId = new Map(base.map((b) => [b.id, b]));
  const out: ReflowBlock[] = [];
  for (const r of refined) {
    const src = byId.get(r.id);
    if (!src) continue;
    if (src.type === 'list') { out.push(src); byId.delete(r.id); continue; } // 列表原样保留结构，只取模型给的位置
    out.push({
      id: src.id,
      type: r.type === 'heading' ? 'heading' : 'para',
      level: r.type === 'heading' ? (r.level || 1) : 0,
      text: r.text || src.text,
      source: src.source, // 原页 bbox 原样保留
    });
    byId.delete(r.id);
  }
  for (const b of base) if (byId.has(b.id)) out.push(b); // 模型漏掉的按原样补回
  return out.length ? out : base;
}

const hybrid: ReflowProvider = async (blocks) => refine(reflowLocal(blocks));
const vision: ReflowProvider = async (blocks) => refine(reflowLocal(blocks), grabPageImage());

export const reflowProviders: Record<string, ReflowProvider> = { local, hybrid, vision };

export const REFLOW_PROVIDER_LABELS: Record<string, string> = {
  local: '仅启发式（即时·保 bbox）',
  hybrid: '启发式 + 模型精修（文字）',
  vision: '启发式 + 视觉重排（Kimi 看图·保 bbox）',
};
