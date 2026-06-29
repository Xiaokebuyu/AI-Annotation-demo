import { describe, expect, it } from 'vitest';
import { evidenceGrounded, parseConceptCandidates, parseConcepts } from './concept-extract';

describe('parseConcepts', () => {
  it('每行一个概念词·封顶 3', () => {
    expect(parseConcepts('一致性\n复制\n采样率\n离线优先')).toEqual(['一致性', '复制', '采样率']);
  });
  it('剔编号/项目符号/尾标点', () => {
    expect(parseConcepts('1. 一致性。\n- 复制；\n• 采样率')).toEqual(['一致性', '复制', '采样率']);
  });
  it('去重', () => {
    expect(parseConcepts('一致性\n一致性\n复制')).toEqual(['一致性', '复制']);
  });
  it('空 / 「无」/ 过长行 → 剔', () => {
    expect(parseConcepts('')).toEqual([]);
    expect(parseConcepts('无')).toEqual([]);
    expect(parseConcepts('none\nN/A\n没有')).toEqual([]);
    expect(parseConcepts('这是一段非常长的不像概念词的句子超过二十四个字所以会被剔掉对吧\n一致性')).toEqual(['一致性']);
  });
  it('行首数字是概念一部分时不被腰斩（5G/2PC/3D/1.5）', () => {
    expect(parseConcepts('5G 网络\n2PC\n3D 重建')).toEqual(['5G 网络', '2PC', '3D 重建']);
    expect(parseConcepts('1.5 倍采样')).toEqual(['1.5 倍采样']); // `1.` 后跟数字→不当编号
    expect(parseConcepts('1. 一致性\n2) 复制')).toEqual(['一致性', '复制']); // 真编号列表照样剔
  });
});

describe('parseConceptCandidates', () => {
  it('解析「概念 | 证据 | 置信度」', () => {
    expect(parseConceptCandidates('数据架构 | 数据架构的两层 | 0.95')).toEqual([
      { concept: '数据架构', evidence: '数据架构的两层', confidence: 0.95 },
    ]);
  });
  it('多行·封顶 3·概念词清洗保留 5G', () => {
    const r = parseConceptCandidates('采样率 | 采样率 60Hz | 0.9\n5G 网络 | 上 5G | 0.8\n压感 | 上压感 | 0.7\n多余 | x | 0.6');
    expect(r.map((c) => c.concept)).toEqual(['采样率', '5G 网络', '压感']);
  });
  it('纯词退化行→置信度 0（不开幻觉后门）；有证据但缺置信度列→视作 1；解析不出→0', () => {
    expect(parseConceptCandidates('一致性哈希')).toEqual([{ concept: '一致性哈希', evidence: '', confidence: 0 }]);
    expect(parseConceptCandidates('一致性哈希 | 一致性哈希')).toEqual([{ concept: '一致性哈希', evidence: '一致性哈希', confidence: 1 }]);
    expect(parseConceptCandidates('概念 | 证据 | 高')).toEqual([{ concept: '概念', evidence: '证据', confidence: 0 }]);
  });
  it('置信度夹到 0–1·全角括号也读得出·去重·剔空/「无」', () => {
    expect(parseConceptCandidates('概念 | e | 1.5')[0].confidence).toBe(1);
    expect(parseConceptCandidates('采样率 | 采样率 60Hz | （0.9）')[0].confidence).toBe(0.9); // E：全角括号
    expect(parseConceptCandidates('一致性 | a | 0.9\n一致性 | b | 0.8').map((c) => c.concept)).toEqual(['一致性']);
    expect(parseConceptCandidates('\n无 | x | 0.9\n空 | y | 0.8')).toEqual([]);
  });
  it('证据里含裸竖线不切坏（E）', () => {
    expect(parseConceptCandidates('管道 | a | b | c | 0.9')).toEqual([{ concept: '管道', evidence: 'a | b | c', confidence: 0.9 }]);
  });
  it('evidenceGrounded：证据须是正文非极短子串；空/单字/编造→不接地', () => {
    expect(evidenceGrounded('数据架构的两层', '今天想清楚数据架构的两层')).toBe(true);
    expect(evidenceGrounded('', '正文')).toBe(false); // 空证据=不接地（C 关后门）
    expect(evidenceGrounded('的', '今天的笔记')).toBe(false); // 单字=假接地
    expect(evidenceGrounded('接口一致性', '这块要对齐')).toBe(false); // 编造（不在正文）
  });
});
