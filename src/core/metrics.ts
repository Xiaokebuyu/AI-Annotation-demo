import { bus } from '../app/state';

/** 分段延迟，喂周五 I2 scorecard */
const stages = {
  pen_event: [] as number[],
  event_ocr: [] as number[],
  ocr_result: [] as number[],
  result_screen: [] as number[],
  total: [] as number[],
};

export type Stage = keyof typeof stages;

export const STAGE_LABELS: Record<Stage, string> = {
  pen_event: 'pen-up → event',
  event_ocr: 'event → OCR',
  ocr_result: 'OCR → result',
  result_screen: 'result → 上屏',
  total: '全链路',
};

/** 北极星指标雏形：每 N 次标注中被接受/编辑的反馈数 */
export const counters = { accepted: 0, edited: 0, dismissed: 0, cards: 0 };

export function mark(stage: Stage, ms: number): void {
  stages[stage].push(Math.round(ms));
  bus.emit('metrics');
}

export function bump(key: keyof typeof counters): void {
  counters[key]++;
  bus.emit('metrics');
}

export function p50(arr: number[]): number | null {
  if (!arr.length) return null;
  return [...arr].sort((a, b) => a - b)[arr.length >> 1];
}

export function snapshot(): Array<{ stage: Stage; label: string; last: number | null; p50: number | null }> {
  return (Object.keys(stages) as Stage[]).map((s) => ({
    stage: s,
    label: STAGE_LABELS[s],
    last: stages[s].length ? stages[s][stages[s].length - 1] : null,
    p50: p50(stages[s]),
  }));
}
