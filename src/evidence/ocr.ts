import type { NormBBox } from '../core/contracts';

/**
 * 把标注 bbox（归一化 [0,1]）那一块从 #page-layer canvas 裁出来 → PNG dataURL。
 * 裁剪框用标注几何 + pad（粗但诚实）。缩到长边 ≤max 控 token。
 * 失败（canvas 不可用/跨域污染）返回 undefined。
 */
export function grabRegion(bbox: NormBBox, pad = 0.02, max = 768): string | undefined {
  const cv = document.getElementById('page-layer') as HTMLCanvasElement | null;
  if (!cv || !cv.width || !cv.height) return undefined;
  const [bx, by, bw, bh] = bbox;
  const x0 = Math.max(0, bx - pad), y0 = Math.max(0, by - pad);
  const x1 = Math.min(1, bx + bw + pad), y1 = Math.min(1, by + bh + pad);
  const sx = x0 * cv.width, sy = y0 * cv.height;
  const sw = Math.max(1, (x1 - x0) * cv.width), sh = Math.max(1, (y1 - y0) * cv.height);
  try {
    const scale = Math.min(1, max / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d')!.drawImage(cv, sx, sy, sw, sh, 0, 0, w, h);
    return tmp.toDataURL('image/png');
  } catch {
    return undefined;
  }
}

/**
 * 一次裁出同一裁剪框、同取景的两张图（多图 grounding）：
 *   ink       —— 只有用户笔迹，铺白底（手写从黑字里剥离，最利于识别手写）
 *   composite —— 两层叠加（墨迹叠原文，判断画在哪、圈住了什么）
 * 两张共享同一 sx/sy/sw/sh 与输出尺寸，模型可做"图层对齐"。任一画布缺失则该张缺省。
 * 原文层(page)已弃：与整页文字 pageText 重复、纯耗 vision token + 多一次 JPEG 编码，不再生成。
 */
export function grabLayers(bbox: NormBBox, pad = 0.04, max = 900): { ink?: string; composite?: string } {
  const page = document.getElementById('page-layer') as HTMLCanvasElement | null;
  const ink = document.getElementById('ink-layer') as HTMLCanvasElement | null;
  if (!page || !page.width || !page.height) return {};
  const [bx, by, bw, bh] = bbox;
  const x0 = Math.max(0, bx - pad), y0 = Math.max(0, by - pad);
  const x1 = Math.min(1, bx + bw + pad), y1 = Math.min(1, by + bh + pad);
  const sx = x0 * page.width, sy = y0 * page.height;
  const sw = Math.max(1, (x1 - x0) * page.width), sh = Math.max(1, (y1 - y0) * page.height);
  const scale = Math.min(1, max / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale));
  const hasInk = !!(ink && ink.width === page.width && ink.height === page.height);
  // 体积控制：合成层=JPEG（渲染文字 q0.78 仍清晰，比 PNG 小 60–75%）；
  // 笔迹层=PNG（白底细黑笔画，留无损以保手写识别）。服务端按 dataURL 前缀透传 media_type。
  const make = (draw: (ctx: CanvasRenderingContext2D) => void, mime = 'image/png', q?: number): string | undefined => {
    try {
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      draw(tmp.getContext('2d')!);
      return tmp.toDataURL(mime, q);
    } catch { return undefined; }
  };
  const JPEG_Q = 0.78;
  return {
    ink: hasInk ? make((ctx) => { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(ink!, sx, sy, sw, sh, 0, 0, w, h); }) : undefined,
    composite: make((ctx) => { ctx.drawImage(page, sx, sy, sw, sh, 0, 0, w, h); if (hasInk) ctx.drawImage(ink!, sx, sy, sw, sh, 0, 0, w, h); }, 'image/jpeg', JPEG_Q),
  };
}
