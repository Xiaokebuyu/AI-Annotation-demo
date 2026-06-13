/**
 * Transform 栈 —— 坐标换算只发生在这里（决策 D1 的代码化身）。
 * 页面归一化坐标 [0,1]² ⇄ 页面 CSS 像素。缩放只改变 pageCss，归一化值不变。
 */

export const pageCss = { w: 0, h: 0 };

export function setPageSize(w: number, h: number): void {
  pageCss.w = w;
  pageCss.h = h;
}

export const normToPx = (nx: number, ny: number) => ({ x: nx * pageCss.w, y: ny * pageCss.h });
export const pxToNorm = (px: number, py: number) => ({ x: px / pageCss.w, y: py / pageCss.h });

export interface SelfTestResult {
  ok: boolean;
  maxErr: number;
  samples: number;
}

export function selfTest(samples = 1000): SelfTestResult {
  if (!pageCss.w || !pageCss.h) return { ok: false, maxErr: NaN, samples: 0 };
  let maxErr = 0;
  for (let i = 0; i < samples; i++) {
    const nx = Math.random();
    const ny = Math.random();
    const p = normToPx(nx, ny);
    const back = pxToNorm(p.x, p.y);
    maxErr = Math.max(maxErr, Math.abs(back.x - nx), Math.abs(back.y - ny));
  }
  return { ok: maxErr < 1e-9, maxErr, samples };
}
