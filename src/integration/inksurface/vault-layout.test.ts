import { describe, expect, it } from 'vitest';
// ⚠️交叉核对：直接 import 协作方 SDK 的真命名函数，断言我们的镜像逐字一致。
// 一旦对方改 file-name.ts 的 sanitize/命名规则 → 本测试即红（计划要求的耦合守卫）。
import {
  sourceNoteBaseName as sdkSourceNoteBaseName,
  sanitizeFileName as sdkSanitizeFileName,
} from '../../../ink-surface-sdk-main/examples/ai-annotation-demo/src/adapters/markdown/file-name';
import {
  entityModeOf,
  folderSlug,
  sanitizeName,
  sourceNoteBaseName,
  tagSlug,
  taxonomyTags,
  vaultFolderForEntity,
  vaultRootFolder,
  type VaultEntity,
} from './vault-layout';

describe('entityModeOf', () => {
  it('按 id 前缀判 mode', () => {
    expect(entityModeOf('doc_abc123def456')).toBe('reading');
    expect(entityModeOf('diary_ab12cd34')).toBe('diary');
    expect(entityModeOf('mtgdoc_m123')).toBe('meeting');
    expect(entityModeOf('mtgboard_m123')).toBe('meeting');
    expect(entityModeOf('mtgdoc_m123_msg9')).toBe('meeting'); // 会议资料文档仍属会议
  });
});

describe('sanitizeName ↔ SDK 交叉核对', () => {
  const samples = [
    '深入理解计算机系统',
    'A/B:C?D*E|F',
    'Trailing dots...',
    '  collapse   ws  ',
    'ﬁ NFKC 连字',
    '架构评审 v4',
    'doc_abc123def456',
    'mtgdoc_m123',
    '#^[brackets]^#',
    'x'.repeat(160),
    'Untitled?', // 非空
  ];
  it('每个样本与 SDK sanitizeFileName 逐字一致', () => {
    for (const s of samples) expect(sanitizeName(s)).toBe(sdkSanitizeFileName(s));
  });
  it('空串 → Untitled', () => {
    expect(sanitizeName('')).toBe('Untitled');
    expect(sanitizeName('   ')).toBe('Untitled');
  });
});

describe('sourceNoteBaseName ↔ SDK 交叉核对（MOC 链接目标）', () => {
  const pairs: Array<[string, string]> = [
    ['深入理解计算机系统', 'doc_abc123def456'],
    ['架构评审 v4', 'mtgdoc_m123'],
    ['6.29 日记', 'diary_ab12cd34'],
    ['A/B:C? 长'.repeat(20), 'doc_x'], // 触发 title 100 截断
    ['标题#带^非法[字符]', 'mtgboard_m9'],
  ];
  it('每对 (title, id) 与 SDK sourceNoteBaseName 逐字一致', () => {
    for (const [t, id] of pairs) expect(sourceNoteBaseName(t, id)).toBe(sdkSourceNoteBaseName(t, id));
  });
  it('basename 含 document_id → 跨实体唯一', () => {
    const a = sourceNoteBaseName('同名书', 'doc_aaa');
    const b = sourceNoteBaseName('同名书', 'doc_bbb');
    expect(a).not.toBe(b);
  });
});

describe('folderSlug', () => {
  it('走 SDK sanitize + 80 截断', () => {
    expect(folderSlug('深入理解计算机系统')).toBe('深入理解计算机系统');
    expect(folderSlug('a/b')).toBe('a b');
    expect(folderSlug('x'.repeat(120)).length).toBe(80);
  });
});

describe('vaultFolderForEntity', () => {
  it('reading 按标题 slug', () => {
    const e: VaultEntity = { documentId: 'doc_x', documentTitle: '深入理解计算机系统', mode: 'reading' };
    expect(vaultFolderForEntity(e)).toEqual({
      base_dir: 'InkLoop/Reading/深入理解计算机系统',
      documents_dir: 'InkLoop/Reading/深入理解计算机系统',
    });
  });
  it('diary 按日期落夹', () => {
    const e: VaultEntity = { documentId: 'diary_ab12', documentTitle: '6.29 日记', mode: 'diary', date: '2026-06-29' };
    expect(vaultFolderForEntity(e)).toEqual({
      base_dir: 'InkLoop/Diary/2026-06-29',
      documents_dir: 'InkLoop/Diary/2026-06-29',
    });
  });
  it('meeting 无日期回退标题 slug', () => {
    const e: VaultEntity = { documentId: 'mtgdoc_m1', documentTitle: '架构评审 v4', mode: 'meeting' };
    expect(vaultFolderForEntity(e)).toEqual({
      base_dir: 'InkLoop/Meetings/架构评审 v4',
      documents_dir: 'InkLoop/Meetings/架构评审 v4',
    });
  });
  it('meeting 带日期→`<日期> <标题>`（周期性同名会议不挤一夹）', () => {
    const a: VaultEntity = { documentId: 'mtgdoc_m1', documentTitle: '周会', mode: 'meeting', date: '2026-06-29' };
    const b: VaultEntity = { documentId: 'mtgdoc_m2', documentTitle: '周会', mode: 'meeting', date: '2026-07-06' };
    expect(vaultFolderForEntity(a).base_dir).toBe('InkLoop/Meetings/2026-06-29 周会');
    expect(vaultFolderForEntity(b).base_dir).toBe('InkLoop/Meetings/2026-07-06 周会');
    expect(vaultFolderForEntity(a).base_dir).not.toBe(vaultFolderForEntity(b).base_dir); // 同名不同期→分夹
  });
  it('diary 缺 date 有兜底', () => {
    const e: VaultEntity = { documentId: 'diary_x', documentTitle: 'x', mode: 'diary' };
    expect(vaultFolderForEntity(e).base_dir).toBe('InkLoop/Diary/未注明日期');
  });
  it('全部落在可见 InkLoop 下（非隐藏 .inkloop）', () => {
    const e: VaultEntity = { documentId: 'doc_x', documentTitle: '书', mode: 'reading' };
    expect(vaultFolderForEntity(e).base_dir.startsWith('InkLoop/')).toBe(true);
    expect(vaultFolderForEntity(e).base_dir.startsWith('.inkloop')).toBe(false);
  });
});

describe('vaultRootFolder', () => {
  it('MOC/根 = 顶层 InkLoop', () => {
    expect(vaultRootFolder()).toEqual({ base_dir: 'InkLoop', documents_dir: 'InkLoop' });
  });
});

describe('tagSlug（Obsidian 标签不能含空格/标点）', () => {
  it('空格 → 连字符·标点剔除·CJK 保留', () => {
    expect(tagSlug('架构评审 v4')).toBe('架构评审-v4'); // 空格→- 否则 Obsidian 截断标签
    expect(tagSlug('深入理解计算机系统')).toBe('深入理解计算机系统');
    expect(tagSlug('A/B: C?')).toBe('A-B-C');
  });
  it('日期保持可读', () => {
    expect(tagSlug('2026-06-29')).toBe('2026-06-29');
  });
});

describe('taxonomyTags', () => {
  it('reading：mode + book/<slug> + date（slug 无空格）', () => {
    expect(
      taxonomyTags({ documentId: 'doc_x', documentTitle: '架构评审 v4', isoDate: '2026-06-29T08:00:00Z' }),
    ).toEqual(['inkloop/reading', 'inkloop/book/架构评审-v4', 'inkloop/date/2026-06-29']);
  });
  it('diary：实体 slug 用日期', () => {
    expect(
      taxonomyTags({ documentId: 'diary_x', documentTitle: '6.29 日记', isoDate: '2026-06-29T22:00:00Z' }),
    ).toEqual(['inkloop/diary', 'inkloop/diary/2026-06-29', 'inkloop/date/2026-06-29']);
  });
  it('meeting：mode 自 mtgdoc_ 派生·date 可被会议日期覆盖', () => {
    expect(
      taxonomyTags({ documentId: 'mtgdoc_m1', documentTitle: '周会', isoDate: '2026-06-29T01:00:00Z', date: '2026-06-28' }),
    ).toEqual(['inkloop/meeting', 'inkloop/meeting/周会', 'inkloop/date/2026-06-28']);
  });
});
