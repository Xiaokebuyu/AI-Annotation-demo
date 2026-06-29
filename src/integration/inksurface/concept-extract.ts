/**
 * 概念抽取器（真实现·browser·调 /api/chat 的 concept_extractor role）—— 工厂返回 ConceptExtractFn 喂给 buildConceptLayer。
 *
 * 两个机制：① **防起名漂移**=把运行中已发现的概念词喂给 LLM 让它复用现名（别造同义新词）；
 *          ② **本次导出去重**=按 KO content_hash 缓存（同内容只调一次·省 token）。
 * 跨导出的持久缓存（按 content_hash 落库·增量只抽改动笔记）留 v2。失败/中断返回 []（不连累导出）。
 */
import { postNdjson } from '../../core/api';
import { promptVersion } from '../../core/prompt-versions';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import type { ConceptExtractFn } from './concept-layer';

const MAX_CONCEPTS = 3;

/** 解析 LLM 输出：每行一个概念词·剔编号/项目符号/尾标点/空行/「无」·去重·封顶 3。纯·可单测。 */
export function parseConcepts(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((l) => l.replace(/^[\s\-*•·\d.、)]+/, '').replace(/[。.;；,，]+$/, '').trim())
        .filter((l) => l && l.length <= 24 && !/^(无|none|n\/?a|没有|空)$/i.test(l)),
    ),
  ].slice(0, MAX_CONCEPTS);
}

/** 工厂：返回带「词表复用 + content_hash 缓存」的 ConceptExtractFn。opts.model 默认网关默认（kimi）。 */
export function makeConceptExtractor(opts: { model?: string; signal?: AbortSignal } = {}): ConceptExtractFn {
  const vocab: string[] = []; // 运行中已发现的概念词（喂 LLM 复用）
  const cache = new Map<string, string[]>(); // content_hash → 概念词（本次导出去重）
  const ver = promptVersion('concept_extractor');

  return async (ko: KnowledgeObject): Promise<string[]> => {
    const key = `${ver}:${ko.content_hash}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const content = [
      `笔记类型：${ko.kind}`,
      ko.source.document_title ? `来源：${ko.source.document_title}` : '',
      vocab.length ? `已有概念词（同义就复用·别另起新词）：${vocab.slice(-50).join('、')}` : '',
      `笔记内容：\n${ko.body_md}`,
    ]
      .filter(Boolean)
      .join('\n');

    let full = '';
    let done = false;
    let err = '';
    try {
      await postNdjson<{ k?: string; d?: string }>(
        '/api/chat',
        { messages: [{ role: 'user', content }], role: 'concept_extractor', model: opts.model, maxTokens: 80 },
        (f) => {
          if (f.k === 'e') err = f.d || '中断';
          else if (f.k === 'done') done = true;
          else if (f.k === 't' && f.d) full += f.d;
        },
        { signal: opts.signal },
      );
    } catch {
      return [];
    }
    if (err || !done) return [];

    const concepts = parseConcepts(full);
    for (const c of concepts) if (!vocab.includes(c)) vocab.push(c);
    cache.set(key, concepts);
    return concepts;
  };
}
