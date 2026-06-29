import { describe, expect, it } from 'vitest';
import { parseConcepts } from './concept-extract';

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
});
