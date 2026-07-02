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
import type { InferenceView, MarkGraph, MarkNode, PriorNeighbor, QuadrantLabel } from '../core/contracts';
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

/** 画（自由笔·非文字）：feature_type=drawing 或 shape=sketch。text 此时是"像什么"的粗描述、非转写。 */
function isDrawing(node: MarkNode): boolean {
  return node.feature_type === 'drawing' || node.shape === 'sketch';
}

// 注：曾把所有 mode==='self_content' 都当"写"，导致"圈住一片空白/普通墨迹"（markup+self_content，
// 没锚到印刷内容）被叙事成"仔细写了一段"——圈和写是两个动作，不该混为一谈。圈选类节点的叙事交给
// 下面 markLabel/referTo 已有的 `${VERB[node.shape]}「xxx」`（如"圈「xxx」"）分支，不依赖这里兜底。
function isWriting(node: MarkNode): boolean {
  return node.feature_type === 'handwriting' || node.shape === 'handwriting';
}

/** 运笔方式 → 副词前缀 / 重描后缀（Slice A）。只在 manner 明显时点缀，否则保持中性。 */
const MANNER_ADVERB: Record<string, string> = { hesitant: '迟疑地', decisive: '果断地', careful: '仔细地' };
function withManner(node: MarkNode, phrase: string): string {
  const m = node.manner;
  if (!m) return phrase;
  let out = phrase;
  if (m.adverb && MANNER_ADVERB[m.adverb]) out = MANNER_ADVERB[m.adverb] + out;
  if (m.retraced) out += '（反复描了几次）';
  return out;
}

function phraseFor(node: MarkNode, text: string): string {
  // 画优先于写：画也是 self_content，但它是"画"不是"写"——text 是粗描述（一张笑脸…），让模型知道这是图。
  const base = isDrawing(node) ? (text ? `画「${text}」` : '画了一处')
    : isWriting(node) ? (text ? `写下「${text}」` : '写了一段')
      : text ? `${VERB[node.shape] ?? '标注'}「${text}」` : `${VERB[node.shape] ?? '标注'}了一处`;
  return withManner(node, base);
}

/** 空间子句里对一个 mark 的简短指代：有字用「字」，无字退回动词短语。 */
function refOf(node: MarkNode, text: string): string {
  if (text) return `「${text}」`;
  if (isDrawing(node)) return '画的那处';
  if (isWriting(node)) return '手写那段';
  return `${VERB[node.shape] ?? '标注'}的那处`;
}

/** 空间关系强弱：同一对 mark 取最强的一类，避免重复子句。 */
const SPATIAL_RANK: Record<string, number> = { containment: 3, same_target: 2, proximity: 1 };

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
    priorNeighbors?: PriorNeighbor[]; // 空间召回回来的同页邻近旧标注（回访子句用；不进 graph.nodes）
    rowText?: string;                 // ②：手写问题纵向压着的印刷正文行（指代用）
    pageAnnotations?: InferenceView['page_annotations']; // 本页其他批注+旧回应（动态背景）
    thematic?: InferenceView['thematic']; // 全书主题联想（向量召回·现 no-op）
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

  // 空间子句（根因 B）：把同段内**非时间相邻**的空间关系写进叙事——这些边 buildMarkGraph 恒算，
  // 但此前只走时间链、从不读它。相邻对已由四象限连接词表达，故跳过，避免重复；有界封顶 3 条。
  const adjacent = new Set<string>();
  for (let i = 1; i < nodes.length; i++) adjacent.add(`${nodes[i - 1].mark_id}|${nodes[i].mark_id}`);
  const pairBest = new Map<string, { from: string; to: string; rel: string }>();
  for (const e of graph.edges) {
    if (e.kind !== 'spatial') continue;
    if (adjacent.has(`${e.from}|${e.to}`) || adjacent.has(`${e.to}|${e.from}`)) continue; // 相邻对：连接词已表达
    const key = [e.from, e.to].sort().join('|');
    const prev = pairBest.get(key);
    if (!prev || (SPATIAL_RANK[e.rel] ?? 0) > (SPATIAL_RANK[prev.rel] ?? 0)) pairBest.set(key, { from: e.from, to: e.to, rel: e.rel });
  }
  const nodeById = new Map(nodes.map((n) => [n.mark_id, n] as const));
  const refText = (id: string): string => { const n = nodeById.get(id); return n ? refOf(n, nodeText(n)) : '某处'; };
  const spatialClauses: string[] = [];
  for (const { from, to, rel } of pairBest.values()) {
    if (spatialClauses.length >= 3) break;
    const a = refText(from), b = refText(to);
    spatialClauses.push(
      rel === 'containment' ? `${a}圈住了${b}`
        : rel === 'same_target' ? `${a}、${b}落在同一处文字上`
          : `${a}与${b}紧挨在一处`,
    );
  }
  if (spatialClauses.length) narrative += `；位置关系上，${spatialClauses.join('；')}`;

  // 回访子句（根因 A）：这附近先前已标过的旧标注（空间召回·账本捞回，**非当前动作**，清晰区隔）。
  const recall = opts.priorNeighbors ?? [];
  if (recall.length) narrative += `（这附近你先前标过：${recall.map((r) => r.reply ? `「${r.text}」(当时我说:${r.reply})` : `「${r.text}」`).join('、')}）`;

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
    recall: recall.length ? recall : undefined,
    referent_lines: opts.rowText?.trim() || undefined,
    page_annotations: opts.pageAnnotations?.length ? opts.pageAnnotations : undefined,
    thematic: opts.thematic?.length ? opts.thematic : undefined,
    version: INFERVIEW_SCHEMA_VERSION,
  };
}
