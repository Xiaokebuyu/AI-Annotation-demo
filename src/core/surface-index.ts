/**
 * SurfaceIndex 工厂（C1：surface 抽象上抬）。
 *
 * 三条 surface 路径（article=PDF/有文层、chat=合成聊天、whiteboard=空白可写面）此前各自手写
 * `{ surface_id, surface_type, page_index, objects }` 字面量。收口到这里：surface_type 词汇集中在
 * contracts.SurfaceType，信封构造唯一来源；日记=空白面，直接复用 blankSurfaceIndex。
 */
import type { SurfaceIndex, SurfaceObject, SurfaceType } from './contracts';

export function makeSurfaceIndex(
  surfaceId: string,
  surfaceType: SurfaceType,
  objects: SurfaceObject[],
  pageIndex = 0,
): SurfaceIndex {
  return { surface_id: surfaceId, surface_type: surfaceType, page_index: pageIndex, objects };
}

/** 空白可写面（白板/日记）：整面一个 blank_region，任何手写都命中 self_content（step⑥）。 */
export function blankSurfaceIndex(surfaceId: string): SurfaceIndex {
  return makeSurfaceIndex(surfaceId, 'whiteboard', [
    { id: 'blank_0', type: 'blank_region', bbox: [0, 0, 1, 1], source: 'structure' },
  ]);
}
