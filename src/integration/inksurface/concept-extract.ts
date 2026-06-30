/**
 * 概念抽取器（真实现·browser·调 /api/chat 的 concept_extractor role）—— 工厂返回 ConceptExtractFn 喂给 buildConceptLayer。
 *
 * v2 = 结构化「概念 | 证据 | 置信度」+ 证据接地（证据必须在正文里）+ 置信度闸 → 根治低上下文幻觉/假桥。
 * 两个老机制保留：① 防起名漂移=把已发现概念词喂回 LLM 复用现名；② 本次导出去重=按 content_hash 缓存。
 * 跨导出持久缓存（按 content_hash 落库·增量抽）留 v2-embedding。失败/中断返回 []（不连累导出）。
 */
import { postNdjson } from '../../core/api';
import { promptVersion } from '../../core/prompt-versions';
import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import type { ConceptExtractFn } from 'ink-surface-sdk/export-core';

const MAX_CONCEPTS = 3;
const MIN_CONFIDENCE = 0.6; // 低于此置信度的概念丢弃（牵强/勉强的不进图）

/** 概念词清洗：剔列表标记前缀（`-`/`•`/`1.`，但 `1.5`/`5G` 的数字不动）+ 尾标点。纯。 */
function cleanWord(s: string): string {
  return s
    .replace(/^\s*(?:[-*•·]\s*|\d+[.)、](?!\d)\s*)/u, '')
    .replace(/[。.;；,，]+$/, '')
    .trim();
}
function isJunkWord(s: string): boolean {
  return !s || s.length > 24 || /^(无|none|n\/?a|没有|空)$/i.test(s);
}
const normKey = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');

export interface ConceptCandidate {
  concept: string;
  evidence: string; // 正文里的原文片段（用于接地校验）
  confidence: number; // 0–1
}

/** 拆「概念 | 证据 | 置信度」一行：先按「空格+竖线+空格」切（容证据里含裸 `|`），不足三段再按裸 `|` 兜底·中段=证据。 */
function splitCandidateLine(line: string): string[] {
  const spaced = line.split(/\s+\|\s+/u);
  if (spaced.length >= 3) return [spaced[0] ?? '', spaced.slice(1, -1).join(' | '), spaced.at(-1) ?? ''];
  const raw = line.split('|');
  if (raw.length >= 3) return [raw[0] ?? '', raw.slice(1, -1).join('|').trim(), raw.at(-1) ?? ''];
  return raw;
}

/** 解析结构化输出「概念 | 证据 | 置信度」逐行。有证据但缺置信度列→视作 1；纯词退化行（无证据）→置信度 0（真实抽取会被接地闸挡掉，不开幻觉后门）。纯·可单测。 */
export function parseConceptCandidates(text: string): ConceptCandidate[] {
  const out: ConceptCandidate[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = splitCandidateLine(line);
    const concept = cleanWord(parts[0] ?? '');
    if (isJunkWord(concept)) continue;
    const key = normKey(concept);
    if (seen.has(key)) continue;
    seen.add(key);
    const evidence = (parts[1] ?? '').trim();
    const confidence = parts.length >= 3 ? clampConfidence(parts[2]) : evidence ? 1 : 0;
    out.push({ concept, evidence, confidence });
    if (out.length >= MAX_CONCEPTS) break;
  }
  return out;
}
function clampConfidence(s: string): number {
  const m = s.normalize('NFKC').match(/(?:\d+(?:\.\d+)?|\.\d+)/u); // 容 `0.9）`/全角括号·抽第一个数字
  const n = m ? Number.parseFloat(m[0]) : Number.NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; // 给了置信度列却解析不出→0（被闸挡掉）
}

/** 旧·纯词逐行解析（保留供测/兜底；不含证据）。 */
export function parseConcepts(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const w = cleanWord(line);
    if (isJunkWord(w)) continue;
    const k = normKey(w);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(w);
    if (out.length >= MAX_CONCEPTS) break;
  }
  return out;
}

/** 证据接地：证据去空白后必须是正文（去空白）的**非极短**子串（≥2 字符）——挡 LLM 编造证据/幻觉概念，也挡「的」这种假接地。证据空=不接地（不开后门）。 */
export function evidenceGrounded(evidence: string, body: string): boolean {
  const e = evidence.replace(/\s/g, '');
  return e.length >= 2 && body.replace(/\s/g, '').includes(e);
}

/** 工厂：返回带「词表复用 + content_hash 缓存 + 证据接地 + 置信度闸」的 ConceptExtractFn。opts.model 默认网关默认（kimi）。 */
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
        // thinking:false——概念抽取是轻分类，不需推理。否则 /api/chat 默认开 thinking，maxTokens 被抬到 minTokens(1280)、
        // kimi 还烧 budget_tokens(1024)，几百条 KO 串行又慢又费 token（见 server/infer.ts gatewayEventStream）。
        { messages: [{ role: 'user', content }], role: 'concept_extractor', model: opts.model, maxTokens: 120, thinking: false },
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

    // 证据接地 + 置信度闸：证据须在正文、置信度达标，才算数（根治幻觉/假桥）。
    const concepts = parseConceptCandidates(full)
      .filter((c) => c.confidence >= MIN_CONFIDENCE && evidenceGrounded(c.evidence, ko.body_md))
      .map((c) => c.concept);
    for (const c of concepts) if (!vocab.includes(c)) vocab.push(c);
    cache.set(key, concepts);
    return concepts;
  };
}
