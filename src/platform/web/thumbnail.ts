/**
 * Web 平台：缩略图工具（F2·从 core/pipeline.ts 抽出最孤立的 DOM 依赖）。
 * core 流水线不再直接碰 Image/canvas——这类 DOM 副作用留在 platform/web。
 */

/** 把 dataURL 压到长边 ≤max → JPEG（控 IndexedDB 体积）。失败/无图返回空串。 */
export function makeThumbnail(dataUrl: string | undefined | null, max = 220): Promise<string> {
  if (!dataUrl) return Promise.resolve('');
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
          cv.getContext('2d')!.drawImage(img, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.6));
        } catch { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = dataUrl;
    } catch { resolve(''); }
  });
}
