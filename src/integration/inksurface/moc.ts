/**
 * MOC（Map of Content）连接器（待办1·全量感知）—— 纯函数·无 DOM/store·vitest 可测。
 *
 * Obsidian graph 只读 `[[wikilink]]`+`#tag`。协作方 adapter 已免费给每个叶子 KO 加「→源文档枢纽」回链
 * （render-knowledge-object.ts），故**岛内已连通**；缺的是**岛间连接**——本模块合成 MOC 枢纽笔记把各文档枢纽串起来：
 *   · 每日 MOC：把某天的 阅读/会议/日记 枢纽并到一篇（用户选的「时间维度」·跨模式连接命门）。
 *   · 每模式 MOC：列该模式全部枢纽。
 *   · 根 MOC：链三个模式 MOC + 最近的每日 MOC。
 *
 * MOC = 一个 **document_projection**（adapter 无 MOC 概念·只能当普通文档写）；native renderer 只写 标题+block text_md、
 * **无 frontmatter** → 标签走**正文内联 `#tag`**（Obsidian 照样索引）。链接目标=**文档枢纽基名**
 * `sourceNoteBaseName(title, id)`（含 document_id·唯一·跨文件夹仍可解析）——**只链文档枢纽、不链叶子 KO**
 * （叶子标题会碰撞+已免费回链枢纽·避免毛球）。复用 contract 的 projection 哈希原语 → 过对方 validator。
 */

import { type EntityMode, sourceNoteBaseName } from './vault-layout';
import {
  DOC_PROJECTION_SCHEMA_VERSION,
  type DocumentProjection,
  type ProjectionBlock,
  type ProjectionBlockKind,
  docUri,
  projectionBodyHash,
  projectionContentHash,
  stableToken,
} from './contract';

/** MOC 输入：一个被导出的实体（书/日记/会议）+ 它有活动的日期集合（去重·YYYY-MM-DD）。 */
export interface MocEntity {
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
  dates: string[];
}

export interface MocOpts {
  generatedAt: string;
  appVersion?: string;
  recentDailyLimit?: number; // 根 MOC 里列最近多少篇每日 MOC（默认 30）
}

const MODE_LABEL: Record<EntityMode, string> = { reading: '阅读', diary: '日记', meeting: '会议' };
const MODE_VERB: Record<EntityMode, string> = { reading: '读了', meeting: '开了', diary: '写了' };
const MODE_ORDER: EntityMode[] = ['reading', 'meeting', 'diary'];
const ROOT_MOC_ID = 'moc_root';
const ROOT_MOC_TITLE = 'InkLoop';
const modeMocId = (m: EntityMode): string => `moc_mode_${m}`;
const dateMocId = (d: string): string => `moc_date_${d}`;

/** wikilink 显示文本里清掉会破坏 `[[a|b]]` 的字符（链接目标基名已经过 sanitize·不含这些）。 */
const linkDisplay = (s: string): string => s.replace(/[[\]|]+/g, ' ').trim() || 'Untitled';
/** `[[文档枢纽基名|标题]]`：链到某实体的源笔记/会议文档枢纽。 */
const hubLink = (e: { documentTitle: string; documentId: string }): string =>
  `[[${sourceNoteBaseName(e.documentTitle, e.documentId)}|${linkDisplay(e.documentTitle)}]]`;
/** `[[MOC基名|显示]]`：链到另一篇 MOC。 */
const mocLink = (mocId: string, mocTitle: string, display: string): string =>
  `[[${sourceNoteBaseName(mocTitle, mocId)}|${linkDisplay(display)}]]`;

interface Line {
  kind: ProjectionBlockKind;
  text: string;
  level?: number;
}
const heading = (text: string, level: number): Line => ({ kind: 'heading', text, level });
const para = (text: string): Line => ({ kind: 'paragraph', text });
const bullets = (links: string[]): Line => para(links.map((l) => `- ${l}`).join('\n'));

/** lines → 一篇 MOC document_projection（哈希与对方 validator 同口径·过校验）。 */
async function mocProjection(mocId: string, title: string, lines: Line[], opts: MocOpts): Promise<DocumentProjection> {
  const appVersion = opts.appVersion ?? '0.1.0';
  const blocks: ProjectionBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const block_id = `blk_${String(i + 1).padStart(3, '0')}_${await stableToken(`${mocId}|${i}|${ln.text}`)}`;
    blocks.push({
      block_id,
      kind: ln.kind,
      ...(ln.kind === 'heading' ? { heading_level: Math.min(6, Math.max(1, ln.level ?? 2)) } : {}),
      text_md: ln.text,
      region: 'generated',
      knowledge_object_ids: [], // 显式 []：与 zod default 一致 → content_hash 跨我方/对方可对齐
    });
  }
  const body_hash = await projectionBodyHash(blocks);
  const base: Omit<DocumentProjection, 'content_hash'> = {
    schema_version: DOC_PROJECTION_SCHEMA_VERSION,
    projection_id: `dp_${mocId}`,
    document_id: mocId,
    document_title: title,
    document_uri: docUri(mocId),
    revision_id: `rev_${body_hash.replace('sha256:', '').slice(0, 16)}`,
    generated_at: opts.generatedAt,
    source: { app: 'inkloop', app_version: appVersion },
    privacy: 'export_allowed',
    export_policy: { include_full_text: true, include_pdf_asset: false, include_raw_strokes: false, include_debug_evidence: false },
    blocks,
    body_hash,
    created_at: opts.generatedAt,
    updated_at: opts.generatedAt,
  };
  return { ...base, content_hash: await projectionContentHash(base) };
}

/** 按 mode 把实体分组（保 MODE_ORDER 顺序·组内按标题稳定排序）。 */
function groupByMode(entities: MocEntity[]): Array<{ mode: EntityMode; items: MocEntity[] }> {
  return MODE_ORDER.map((mode) => ({
    mode,
    items: entities.filter((e) => e.mode === mode).sort((a, b) => a.documentTitle.localeCompare(b.documentTitle) || a.documentId.localeCompare(b.documentId)),
  })).filter((g) => g.items.length > 0);
}

/**
 * entities → 全部 MOC document_projection（每日 + 每模式 + 根）。纯函数·确定性。
 * 不变量：每个有活动日期的实体都进对应每日 MOC（零丢失）；每个实体都进其模式 MOC；根串全部模式 + 最近每日。
 */
export async function buildMocProjections(entities: MocEntity[], opts: MocOpts): Promise<DocumentProjection[]> {
  const out: DocumentProjection[] = [];
  if (!entities.length) return out;

  // ① 每日 MOC：date → 当天有活动的实体（按 mode 分组）。
  const dateSet = new Set<string>();
  for (const e of entities) for (const d of e.dates) dateSet.add(d);
  const dates = [...dateSet].sort(); // 升序
  for (const d of dates) {
    const active = entities.filter((e) => e.dates.includes(d));
    const grouped = groupByMode(active);
    const lines: Line[] = [heading(d, 1), para(`#inkloop/moc #inkloop/date/${d}`)];
    // 「日记式」一句话（用户原话「6/29 我读了X、开了Y会、写了Z日记」）——让当天 MOC 读起来像一天的日志、非纯索引。
    const sentence = grouped.map((g) => `${MODE_VERB[g.mode]} ${g.items.map(hubLink).join('、')}`).join('，');
    if (sentence) lines.push(para(`${d} ${sentence}。`));
    for (const g of grouped) {
      lines.push(heading(MODE_LABEL[g.mode], 2));
      lines.push(bullets(g.items.map(hubLink)));
    }
    out.push(await mocProjection(dateMocId(d), d, lines, opts));
  }

  // ② 每模式 MOC：列该模式全部实体。
  for (const g of groupByMode(entities)) {
    const lines: Line[] = [
      heading(MODE_LABEL[g.mode], 1),
      para(`#inkloop/moc #inkloop/${g.mode}`),
      bullets(g.items.map(hubLink)),
    ];
    out.push(await mocProjection(modeMocId(g.mode), MODE_LABEL[g.mode], lines, opts));
  }

  // ③ 根 MOC：链三个模式 MOC + 最近 N 篇每日 MOC。
  const presentModes = MODE_ORDER.filter((m) => entities.some((e) => e.mode === m));
  const recentLimit = opts.recentDailyLimit ?? 30;
  const recentDates = [...dates].reverse().slice(0, recentLimit); // 最近在前
  const rootLines: Line[] = [
    heading(ROOT_MOC_TITLE, 1),
    para('#inkloop/moc'),
    heading('模式', 2),
    bullets(presentModes.map((m) => mocLink(modeMocId(m), MODE_LABEL[m], MODE_LABEL[m]))),
  ];
  if (recentDates.length) {
    rootLines.push(heading('最近', 2));
    rootLines.push(bullets(recentDates.map((d) => mocLink(dateMocId(d), d, d))));
  }
  out.push(await mocProjection(ROOT_MOC_ID, ROOT_MOC_TITLE, rootLines, opts));

  return out;
}

export const __mocInternals = { hubLink, mocLink, dateMocId, modeMocId, ROOT_MOC_ID, ROOT_MOC_TITLE };
