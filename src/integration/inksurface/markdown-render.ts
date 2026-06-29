/**
 * 干净 Markdown 渲染器（Vision A 知识图谱）—— 纯函数·无 DOM/store·把 vault bundle 渲成 vanilla Obsidian 可读的 .md。
 *
 * 为什么自己渲染、不走 SDK 的 obsidian-fs adapter：那个 adapter 是**双向同步 host**，会在每个文件夹写一整套
 * sidecar 账本（docs/indexes/_assets/.inkloop-adapter-state/manifest）+ 空 kind 夹 + 带 ko_id 尾巴的文件名——
 * 对"只想在 Obsidian 看一张思维图"是污染。这里**完全掌控命名/文件夹/链接**：零 sidecar、文件名人类可读、
 * wikilink 用干净基名（本渲染器同时分配基名 + 生成链接，保证全局唯一可解析）。同步/插件渲墨迹是另一条消费方（保留 adapter）。
 *
 * 图谱形状：文档枢纽(book/会议/日记) ←Source 回链— 叶子笔记；枢纽 —出链→ 自己的叶子（双向连通）；
 * MOC(每日/每模式/根) 串各枢纽；标签(mode/实体/date) 作聚类。概念层(AI 抽概念)是后续，不在此。
 */

import type { KnowledgeObject } from '../../knowledge/knowledge-object';
import type { ProjectionBlock } from './contract';
import { type EntityMode, MODE_NOUN, tagSlug } from './vault-layout';
import type { VaultBundleEntity, VaultExportBundle } from './vault-export';

export interface RenderedFile {
  path: string; // vault 相对路径
  markdown: string;
}

const VAULT_ROOT = 'InkLoop';
const MODE_LABEL: Record<EntityMode, string> = { reading: '阅读', diary: '日记', meeting: '会议' };
const MODE_VERB: Record<EntityMode, string> = { reading: '读了', meeting: '开了', diary: '写了' };
const MODE_ORDER: EntityMode[] = ['reading', 'meeting', 'diary'];
const CALLOUT: Record<string, string> = { ai_note: 'note', qa: 'question', excerpt: 'quote', annotation: 'note', summary: 'summary', concept: 'tip', task: 'todo' };

/** 文件名/链接安全：剔 Obsidian wikilink + 文件系统危险字符（`[]#^|/\:*?"<>`）+ 压空白 + 去尾点。 */
function safeName(input: string): string {
  return (
    (input ?? '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '') || 'Untitled'
  );
}

/** 叶子节点名＝内容摘录（让图谱节点读起来像「想法」而非文件名）。剥掉会议正文的「（约 m:ss 处手写）」时间尾巴（正文保留）。 */
function excerpt(s: string, n = 32): string {
  const stripped = safeName(s).replace(/[\s]*[(（]约[^)）]*处手写[)）]\s*$/u, '').trim();
  const chars = [...(stripped || safeName(s))];
  return chars.length > n ? `${chars.slice(0, n).join('')}…` : chars.join('');
}

/** 全局唯一基名分配器（wikilink 靠 basename 解析·必须唯一）。
 *  去重键大小写折叠（NFKC + lower）——macOS/Windows 文件系统默认大小写不敏感，否则 `API`/`api` 会覆盖。 */
function makeNamer(): (base: string) => string {
  const used = new Set<string>();
  const key = (s: string): string => s.normalize('NFKC').toLocaleLowerCase('en-US');
  return (base: string): string => {
    const root = safeName(base);
    if (!used.has(key(root))) { used.add(key(root)); return root; }
    for (let i = 2; ; i++) { const c = `${root} ${i}`; if (!used.has(key(c))) { used.add(key(c)); return c; } }
  };
}

/** YAML 标量安全：JSON.stringify 的引号串是合法 YAML——防 tag 含 `:`/`#`/`*`/`&` 等破坏 frontmatter。 */
const yamlStr = (s: string): string => JSON.stringify(s);
const fm = (tags: string[]): string => ['---', 'tags:', ...[...new Set(tags)].map((t) => `  - ${yamlStr(t)}`), '---'].join('\n');
const wl = (name: string): string => `[[${name}]]`;
const calloutOf = (kind: string, body: string): string => {
  const type = CALLOUT[kind] ?? 'note';
  return [`> [!${type}] InkLoop`, ...body.split('\n').map((l) => `> ${l}`)].join('\n');
};
/** 转写文本是外部内容（cue 可含任意字符）→ 转义，**绝不让它生成 markdown 结构或 wikilink**
 *  （否则 cue 里的 `#` 变标题、`[[X]]` 凭空造假节点污染图谱、绕过 namer 唯一性）。 */
const escapeWiki = (s: string): string => s.replace(/\[\[/g, '\\[\\[').replace(/\]\]/g, '\\]\\]');
const headingText = (s: string): string => escapeWiki(s).replace(/\s+/g, ' ').trim();
const paragraphText = (s: string): string =>
  escapeWiki(s.trim())
    .split('\n')
    .map((l) =>
      l
        .replace(/^(\s{0,3})(#{1,6})(\s+)/u, '$1\\$2$3')
        .replace(/^(\s{0,3})>/u, '$1\\>')
        .replace(/^(\s{0,3})([-+*])(\s+)/u, '$1\\$2$3')
        .replace(/^(\s{0,3})(\d+\.)(\s+)/u, '$1\\$2$3'),
    )
    .join('\n');
/** projection 块 → markdown（会议枢纽渲转写：段摘要=## 标题、cue=段落·均转义）。 */
const renderBlocks = (blocks: ProjectionBlock[]): string =>
  blocks.map((b) => (b.kind === 'heading' ? `## ${headingText(b.text_md)}` : paragraphText(b.text_md))).filter(Boolean).join('\n\n');

interface Named {
  entity: VaultBundleEntity;
  hubName: string;
  dir: string;
  leaves: Array<{ ko: KnowledgeObject; name: string }>;
}

/** bundle → 干净 markdown 文件集。纯·确定性。 */
export function renderVaultMarkdown(bundle: VaultExportBundle): RenderedFile[] {
  const namer = makeNamer();
  const files: RenderedFile[] = [];

  // ① 先分配所有基名（枢纽 → 叶子 → MOC·保证 wikilink 目标唯一可解析）。
  const named: Named[] = bundle.entities.map((entity) => {
    const hubName = namer(entity.documentTitle);
    const dir = entity.folder.documents_dir; // 已是 InkLoop/<Mode>/<slug>
    const leaves = entity.knowledgeExport.objects.map((ko) => ({ ko, name: namer(excerpt(ko.body_md) || ko.kind) }));
    return { entity, hubName, dir, leaves };
  });
  const hubByDoc = new Map(named.map((n) => [n.entity.documentId, n] as const));
  const koLeafName = new Map(named.flatMap((n) => n.leaves.map((l) => [l.ko.ko_id, l.name] as const)));

  // 概念枢纽命名（叶子之后分配·防撞名）+ 概念边映射。
  const concepts = bundle.conceptLayer?.concepts ?? [];
  const conceptHubName = new Map(concepts.map((c) => [c.title, namer(c.title)] as const));
  const assignmentsByKo = bundle.conceptLayer?.assignmentsByKo ?? {};
  const membersByConcept = bundle.conceptLayer?.membersByConcept ?? {};

  const allDates = [...new Set(bundle.entities.flatMap((e) => e.dates))].sort();
  const dateName = new Map(allDates.map((d) => [d, namer(d)] as const));
  const presentModes = MODE_ORDER.filter((m) => bundle.entities.some((e) => e.mode === m));
  const modeMocName = new Map(presentModes.map((m) => [m, namer(`${MODE_LABEL[m]} · 全部`)] as const));
  const rootName = namer('InkLoop 总览');

  // ② 枢纽 + 叶子。
  for (const n of named) {
    const { entity, hubName, dir, leaves } = n;
    const hubTags = ['inkloop', `inkloop/${entity.mode}`, `inkloop/${MODE_NOUN[entity.mode]}/${tagSlug(entity.documentTitle)}`];
    const body: string[] = [fm(hubTags), '', `# ${entity.documentTitle}`, ''];
    if (entity.mode === 'meeting') {
      // 会议枢纽渲转写：段摘要本身就是 ## 小节标题（不再额外包一层空的「## 转写」）。
      const txt = renderBlocks(entity.documentProjections.document_projections[0]?.blocks ?? []);
      if (txt) body.push(txt, '');
    }
    if (leaves.length) {
      body.push('## 笔记', '', ...leaves.map((l) => `- ${wl(l.name)}`), '');
    }
    files.push({ path: `${dir}/${hubName}.md`, markdown: `${body.join('\n').trimEnd()}\n` });

    for (const { ko, name } of leaves) {
      const cNames = assignmentsByKo[ko.ko_id] ?? [];
      const tags = [...ko.tags, ...cNames.map((c) => `inkloop/topic/${tagSlug(c)}`)];
      const leaf = [fm(tags), '', `# ${name}`, '', calloutOf(ko.kind, ko.body_md.trim()), '', `**来源**：${wl(hubName)}`];
      if (cNames.length) leaf.push('', `**相关概念**：${cNames.map((c) => wl(conceptHubName.get(c) ?? c)).join('、')}`);
      files.push({ path: `${dir}/${name}.md`, markdown: `${leaf.join('\n')}\n` });
    }
  }

  // ②.5 概念枢纽（语义跨链·概念星系）：叶子 →相关概念→ 这里；这里 →相关笔记→ 各成员叶子（双向）。
  for (const c of concepts) {
    const hub = conceptHubName.get(c.title) ?? c.title;
    const memberLinks = (membersByConcept[c.title] ?? []).map((koId) => koLeafName.get(koId)).filter((n): n is string => !!n).map(wl);
    const lines = [fm(['inkloop', 'inkloop/concept', `inkloop/topic/${tagSlug(c.title)}`]), '', `# ${c.title}`, ''];
    if (memberLinks.length) lines.push('## 相关笔记', '', ...memberLinks.map((l) => `- ${l}`), '');
    files.push({ path: `${VAULT_ROOT}/Concepts/${hub}.md`, markdown: `${lines.join('\n').trimEnd()}\n` });
  }

  // ③ 每日 MOC（跨模式时间脊 + 日记句）。
  for (const d of allDates) {
    const active = bundle.entities.filter((e) => e.dates.includes(d));
    const groups = MODE_ORDER.map((m) => ({ m, items: active.filter((e) => e.mode === m) })).filter((g) => g.items.length);
    const link = (e: VaultBundleEntity) => wl(hubByDoc.get(e.documentId)!.hubName);
    const sentence = groups.map((g) => `${MODE_VERB[g.m]} ${g.items.map(link).join('、')}`).join('，');
    const lines = [fm(['inkloop', 'inkloop/moc', `inkloop/date/${d}`]), '', `# ${d}`, ''];
    if (sentence) lines.push(`${d} ${sentence}。`, '');
    for (const g of groups) lines.push(`## ${MODE_LABEL[g.m]}`, '', ...g.items.map((e) => `- ${link(e)}`), '');
    files.push({ path: `${VAULT_ROOT}/${dateName.get(d)}.md`, markdown: `${lines.join('\n').trimEnd()}\n` });
  }

  // ④ 每模式 MOC。
  for (const m of presentModes) {
    const items = bundle.entities.filter((e) => e.mode === m);
    const lines = [fm(['inkloop', 'inkloop/moc', `inkloop/${m}`]), '', `# ${MODE_LABEL[m]} · 全部`, '', ...items.map((e) => `- ${wl(hubByDoc.get(e.documentId)!.hubName)}`)];
    files.push({ path: `${VAULT_ROOT}/${modeMocName.get(m)}.md`, markdown: `${lines.join('\n')}\n` });
  }

  // ⑤ 根 MOC。
  const recent = [...allDates].reverse().slice(0, 30);
  const root = [fm(['inkloop', 'inkloop/moc']), '', '# InkLoop 总览', '', '## 模式', '', ...presentModes.map((m) => `- ${wl(modeMocName.get(m)!)}`), ''];
  if (recent.length) root.push('## 最近', '', ...recent.map((d) => `- ${wl(dateName.get(d)!)}`), '');
  files.push({ path: `${VAULT_ROOT}/${rootName}.md`, markdown: `${root.join('\n').trimEnd()}\n` });

  return files;
}
