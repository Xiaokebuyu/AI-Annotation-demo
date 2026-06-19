/**
 * inference-view 投影层（确定性蒸馏，无模型）。
 *
 *   输入：标注图（mark graph）+ 整页文字 + 触发类型 +（手写触发时）问题文本。
 *   输出：精简推理载荷 InferenceView —— 有序关系叙事(narrative) + 所标内容(marked) +
 *         必要时 crop 图；**丢掉坐标 / stroke / 分数 / 内部置信**。
 *   主模型与上下文分类器都只消费它（+ 对话上下文），不碰几何。
 *
 * 这层是"采集 ↔ 推理"的合同面，泛化了旧的 pipeline.hmpFocus（单笔取文字）。
 */
import type { InferenceView, MarkGraph, MarkNode, QuadrantLabel } from '../core/contracts';
import { INFERVIEW_SCHEMA_VERSION } from '../core/contracts';
import { shortId } from '../core/ids';

/** 形状 → 中性动词（不带意图，模型自己据上下文判该干嘛）。 */
const VERB: Record<string, string> = {
  enclosure: '圈', underline: '划线', highlight: '高亮', arrow: '画箭头', cross: '划掉',
  handwriting: '写', sketch: '画', unknown: '标注',
};

/** 一个节点"标到了什么文字"——落笔当时已解析进 node.text（跨页提交不依赖 live index）。 */
function nodeText(node: MarkNode): string {
  return (node.text || '').trim();
}

function isWriting(node: MarkNode): boolean {
  return node.feature_type === 'handwriting' || node.mode === 'self_content' || node.shape === 'handwriting';
}

function phraseFor(node: MarkNode, text: string): string {
  if (isWriting(node)) return text ? `写下「${text}」` : '写了一段';
  const verb = VERB[node.shape] ?? '标注';
  return text ? `${verb}「${text}」` : `${verb}了一处`;
}

/** 相邻节点的连接词，按时间×空间四象限。 */
function connector(quad: QuadrantLabel | undefined, gapMs: number): string {
  switch (quad) {
    case 'one_action': return '，随即';
    case 'sweep': return '，接着往下';
    case 'revisit': return `，${Math.max(1, Math.round(gapMs / 1000))} 秒后回到`;
    case 'separate': return '；另外';
    default: return '，又';
  }
}

export function projectInferenceView(
  graph: MarkGraph,
  opts: {
    trigger: 'idle' | 'handwriting';
    pageText: string;
    question?: string;
    crop?: { role: 'ink' | 'composite'; data: string };
    anchorMarkId?: string;
  },
): InferenceView {
  const { trigger, pageText } = opts;
  const nodes = graph.nodes;

  // 相邻时间边的四象限查表
  const quadByPair = new Map<string, QuadrantLabel | undefined>();
  for (const e of graph.edges) {
    if (e.kind === 'temporal') quadByPair.set(`${e.from}>${e.to}`, e.quadrant);
  }

  // 有序关系叙事
  const texts = nodes.map((n) => nodeText(n));
  let narrative = '';
  nodes.forEach((n, i) => {
    const phrase = phraseFor(n, texts[i]);
    if (i === 0) { narrative = phrase; return; }
    const quad = quadByPair.get(`${nodes[i - 1].mark_id}>${n.mark_id}`);
    narrative += connector(quad, n.t - nodes[i - 1].t) + phrase;
  });
  // 箭头语义：附一句方向说明
  for (const e of graph.edges) {
    if (e.kind !== 'semantic' || e.rel !== 'arrow') continue;
    const from = nodes.find((n) => n.mark_id === e.from);
    const to = nodes.find((n) => n.mark_id === e.to);
    if (from && to) narrative += `；并用箭头把「${nodeText(from) || '前者'}」指向「${nodeText(to) || '后者'}」`;
  }

  const marked = texts.filter(Boolean).join(' / ');
  const anchor = (opts.anchorMarkId ? nodes.find((n) => n.mark_id === opts.anchorMarkId) : null) ?? nodes[nodes.length - 1] ?? null;

  return {
    view_id: shortId('view'),
    trigger,
    narrative,
    marked,
    page_context: pageText ? pageText.slice(0, 3200) : undefined, // 滑动窗(~3000，以当前页为中心·前后)；留点余量
    question: trigger === 'handwriting' ? (opts.question || '').trim() || undefined : undefined,
    crop: opts.crop,
    anchor_refs: anchor?.target_object_refs ?? [],
    anchor_bbox: anchor?.bbox ?? [0, 0, 0, 0],
    page_id: anchor?.page_id ?? '',
    version: INFERVIEW_SCHEMA_VERSION,
  };
}
