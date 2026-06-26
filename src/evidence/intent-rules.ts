/**
 * intent 规则（IntentClassifier.java 的忠实 TS 移植）。
 *
 * 端侧 POC 的 intent 判定本就是 6 条关键词规则,极简、可保真;移到 TS 后**前端/dev/套壳都能跑**,
 * 无需原生桥/AAR/板子——让"端侧 intent 能否平替云端上下文分类器(respond/fold)"的 A/B 立刻可测。
 * 规则单一真源放这里;徐的原生 IntentClassifier 留作端侧资产,不再重复用于 A/B。
 *
 * 对齐源:端侧ocr方案/src/main/java/com/example/hmpocrpoc/IntentClassifier.java
 */
export type IntentLabel = 'question' | 'todo' | 'reject' | 'relation' | 'self_note' | 'attention';

/** 返回第一个命中的 needle（用于"命中了哪条"的机械定位）。 */
const firstHit = (t: string, ...needles: string[]): string | undefined => needles.find((n) => t.includes(n));

/**
 * (action, text) → {intent, hit}。intent 同 Java 版（优先级 question→todo→reject→relation→self_note→attention）;
 * hit = 命中了哪条规则/关键词的机械说明（纯规则没有"理由",这是帮 dev 定位为何折叠/放行）。
 */
export function classifyIntentExplained(action: string, text: string): { intent: IntentLabel; hit: string } {
  const t = (text ?? '').trim();
  let h: string | undefined;
  if ((h = firstHit(t, '?', '？', '为什么', '怎么办', '如何', '怎么'))) return { intent: 'question', hit: `命中问号/问词「${h}」` };
  if ((h = firstHit(t, 'TODO', 'todo', '待办', '记得', '要做', '试试', '确认'))) return { intent: 'todo', hit: `命中待办词「${h}」` };
  if (action === 'cross') return { intent: 'reject', hit: '动作=叉' };
  if ((h = firstHit(t, '错', '不对', '不要', '否定'))) return { intent: 'reject', hit: `命中否定词「${h}」` };
  if (action === 'arrow') return { intent: 'relation', hit: '动作=箭头' };
  if ((h = firstHit(t, '关联', '因为', '所以', '导致'))) return { intent: 'relation', hit: `命中关系词「${h}」` };
  if (action === 'handwriting' || action === 'sketch') return { intent: 'self_note', hit: '无关键词命中→手写/画兜底为 self_note（→折叠）' };
  return { intent: 'attention', hit: '无任何命中→默认 attention' };
}

/** (action, text) → 6 标签之一（保留旧签名;A/B 影子等只要 intent 的调用方继续用它）。 */
export function classifyIntentLocal(action: string, text: string): IntentLabel {
  return classifyIntentExplained(action, text).intent;
}
