/**
 * Vault 折叠布局（待办2 folder 整理 + 待办1 链接目标解析）—— 纯函数·无 DOM/store·vitest 可测。
 *
 * 协作方 obsidian-fs 适配器**只按 KO kind 落目录**（path-policy.ts），契约无 folder/path 槽位；
 * 但写入 CLI 的 `base_dir`/`documents_dir`（config.ts → target.ts）由**调用方每次传**：
 *   notes/summaries/concepts/tasks → `<base_dir>/{Notes,Summaries,...}`；source 笔记 + document_projection → `<documents_dir>`。
 * 默认 `base_dir='.inkloop'`（**Obsidian 隐藏点目录**·叶子笔记看不见、不进图谱）。
 * 故本模块给每个实体算出**可见**的 `InkLoop/<Mode>/<slug>`，由导出驱动逐实体传给 CLI → 分目录 + 全部可见。
 *
 * 另复刻 SDK 的源笔记命名（sourceNoteBaseName），供 MOC 生成 `[[文档枢纽]]` 链接目标（见 moc.ts）。
 * ⚠️这是对 SDK file-name.ts 的**镜像耦合**：规则若漂移，vault-layout.test.ts 的交叉核对 + P5 真 vault 链接解析会即时暴露。
 */

export type EntityMode = 'reading' | 'diary' | 'meeting';

/** 一个可导出实体（书/日记/会议）的最小描述。date=YYYY-MM-DD（日记按日落夹、各 KO 打日期标签用）。 */
export interface VaultEntity {
  documentId: string;
  documentTitle: string;
  mode: EntityMode;
  date?: string;
}

export const VAULT_ROOT_DIR = 'InkLoop';
const MODE_DIR: Record<EntityMode, string> = { reading: 'Reading', diary: 'Diary', meeting: 'Meetings' };

/** 由 document_id 前缀判 mode（与 store 的 listBooks/listDiaries + 会议 doc id 约定一致）：
 *  mtgdoc_/mtgboard_ → meeting；diary → diary；其余（doc_ 等）→ reading。 */
export function entityModeOf(documentId: string): EntityMode {
  if (documentId.startsWith('mtgdoc_') || documentId.startsWith('mtgboard_')) return 'meeting';
  if (documentId.startsWith('diary')) return 'diary';
  return 'reading';
}

/* ── SDK 文件名规则镜像（file-name.ts，逐字复刻）──────────────────────────── */

/** = SDK sanitizeFileName：NFKC、剔非法字符、压空白、trim、去尾点/空格、空则 Untitled。 */
export function sanitizeName(input: string): string {
  return (
    (input ?? '')
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/g, '') || 'Untitled'
  );
}

/** = SDK sourceNoteBaseName（无 .md）：源笔记 / document_projection 的文件基名 = MOC `[[基名]]` 的链接目标。
 *  含 document_id（唯一）→ 跨文件夹 basename 仍唯一、`[[基名]]` 全局可解析。 */
export function sourceNoteBaseName(documentTitle: string, documentId: string): string {
  return `${sanitizeName(documentTitle).slice(0, 100)} - ${sanitizeName(documentId)}`;
}

/* ── 文件夹路由 ──────────────────────────────────────────────────────────── */

/** 文件夹段 slug（比文件名更短·仍走 SDK 同款 sanitize 防路径注入）。 */
export function folderSlug(s: string): string {
  return sanitizeName(s).slice(0, 80);
}

/** mode + slug → CLI 的 {base_dir, documents_dir}（同值·实体所有产物都落该可见目录下）。 */
export function folderForMode(mode: EntityMode, slug: string): { base_dir: string; documents_dir: string } {
  const dir = `${VAULT_ROOT_DIR}/${MODE_DIR[mode]}/${slug}`;
  return { base_dir: dir, documents_dir: dir };
}

/** 实体 → 落夹：
 *  · diary  → 按日期（一篇日记＝一天）；
 *  · meeting → `<日期> <标题>`（周期性同名会议如「周会」按日期分开·不挤一夹）；
 *  · reading → 按标题（保持用户要的干净 `Reading/<书名>`；同名书罕见且文件名含 id 不覆盖）。 */
export function vaultFolderForEntity(entity: VaultEntity): { base_dir: string; documents_dir: string } {
  let slug: string;
  if (entity.mode === 'diary') slug = entity.date || '未注明日期';
  else if (entity.mode === 'meeting') slug = folderSlug(entity.date ? `${entity.date} ${entity.documentTitle}` : entity.documentTitle);
  else slug = folderSlug(entity.documentTitle);
  return folderForMode(entity.mode, slug);
}

/** 根 / MOC 落夹＝vault 顶层 InkLoop（枢纽坐落顶层、向下链进各模式目录）。 */
export function vaultRootFolder(): { base_dir: string; documents_dir: string } {
  return { base_dir: VAULT_ROOT_DIR, documents_dir: VAULT_ROOT_DIR };
}

/* ── 标签 taxonomy（待办1·KO frontmatter）────────────────────────────────── */

/** mode → 标签名词（reading 用 book·更符合用户语义）。 */
export const MODE_NOUN: Record<EntityMode, string> = { reading: 'book', diary: 'diary', meeting: 'meeting' };

/** 标签段 slug：**Obsidian 标签不能含空格/标点**（空格会截断标签）→ 比 folderSlug 更严：
 *  非 字母/数字/_/- 一律 → '-'（CJK 经 \p{L} 保留）、压连字符、去首尾、60 截断。 */
export function tagSlug(s: string): string {
  return (
    sanitizeName(s)
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'untitled'
  );
}

/** 某 KO 的 taxonomy 标签：`inkloop/<mode>`、`inkloop/<noun>/<entitySlug>`、`inkloop/date/<YYYY-MM-DD>`。
 *  默认从 KO 自身派生（mode 看 document_id 前缀·entity 用标题或日记日期·date 用 isoDate）；
 *  会议等可显式传 mode/entitySlug/date 覆盖（如用会议 started_at 而非落笔时刻）。 */
export function taxonomyTags(opts: {
  documentId: string;
  documentTitle: string;
  isoDate: string;
  mode?: EntityMode;
  entitySlug?: string;
  date?: string;
}): string[] {
  const mode = opts.mode ?? entityModeOf(opts.documentId);
  const date = (opts.date ?? opts.isoDate).slice(0, 10);
  const entityRaw = opts.entitySlug ?? (mode === 'diary' ? date : opts.documentTitle);
  return [`inkloop/${mode}`, `inkloop/${MODE_NOUN[mode]}/${tagSlug(entityRaw)}`, `inkloop/date/${date}`];
}
