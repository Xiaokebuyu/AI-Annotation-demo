import type { EventType } from './contracts';

/**
 * 阅读会话记忆（逐页）。每页攒下读者的标注记忆 + 翻页时生成的摘要；
 * 跨页综合时把"前文脉络"喂进推理 —— 让 AI 读到第 N 页时记得前面几页关注过什么。
 *
 * Tier1（当前）：always-include 各页摘要（一行一页，便宜）。
 * Tier2（已探通 Kimi tools，下一步）：换成模型按需 recall_page 调取，省 token、更精准。
 */

export interface PageMark {
  discId: string;     // 与段落讨论的 overlay_id 对齐，按它 upsert
  gesture: EventType;
  text: string;       // 圈住/划到的原文
  note: string;       // AI 当时的回应
}

export interface PageMemory {
  index: number;
  summary: string | null;
  marks: PageMark[];
}

const mem = new Map<string, PageMemory>();

function ensure(pageId: string, index: number): PageMemory {
  let m = mem.get(pageId);
  if (!m) { m = { index, summary: null, marks: [] }; mem.set(pageId, m); }
  m.index = index;
  return m;
}

/** 记录/更新一条标注记忆（按 discId upsert，与讨论原地更新一致）。 */
export function recordMark(pageId: string, index: number, mark: PageMark): void {
  const m = ensure(pageId, index);
  const i = m.marks.findIndex((k) => k.discId === mark.discId);
  if (i >= 0) m.marks[i] = mark; else m.marks.push(mark);
}

export function pageMarks(pageId: string): PageMark[] {
  return mem.get(pageId)?.marks ?? [];
}

export function setSummary(pageId: string, summary: string): void {
  const m = mem.get(pageId);
  if (m) m.summary = summary;
}

export function getMemory(pageId: string): PageMemory | undefined {
  return mem.get(pageId);
}

/** 前文脉络：除当前页外，按页序列出各页摘要（无摘要则用标注速览）。供跨页综合注入。 */
export function crossPageContext(currentPageId: string): string {
  const others = [...mem.entries()].filter(([pid, m]) => pid !== currentPageId && (m.summary || m.marks.length));
  others.sort((a, b) => a[1].index - b[1].index);
  const lines = others
    .map(([, m]) => {
      const body = m.summary || m.marks.map((k) => k.text).filter(Boolean).join('；').slice(0, 60);
      return body ? `第${m.index + 1}页：${body}` : '';
    })
    .filter(Boolean);
  return lines.length ? `【前文脉络】\n${lines.join('\n')}\n` : '';
}
