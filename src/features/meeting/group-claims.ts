/**
 * 群认领映射 —— 实时归群「两条腿」里手动那条（用户决策 2026-06-30）。
 *
 * 飞书只在「群内发起的会议」给 group_ids；日历日程/个人会议（如出海创新周会）开始时常拿不到群。
 * 这时用户在「准备会议」认领一次群 → 按【会议号 + 归一标题】记住 claimKey → workspace_id 映射，
 * 之后同号/同名（周期会每次）自动归群、会前文件窗口随之打开。一次认领长期生效。
 *
 * 数据量极小、读写简单、要跨重启不丢 → 用 localStorage（同 panelMeeting.cursor），不进 IndexedDB。
 */

const CLAIMS_KEY = 'inkloop.groupClaims.v1';

/** 从飞书日历 vchat.meeting_url 解析会议号：https://vc.feishu.cn/j/473388422 → "473388422"。拿不到返回 ''。 */
export function meetingNoFromUrl(url?: string | null): string {
  const m = String(url || '').match(/\/j\/(\d+)/);
  return m ? m[1] : '';
}

/** 标题归一（小写 + 去掉所有非字母数字汉字）——周期会同名匹配用，抹平空白/标点差异。 */
function normTopic(s?: string | null): string {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

type ClaimMap = Record<string, string>; // claimKey → workspace_id

function load(): ClaimMap {
  try { return (JSON.parse(localStorage.getItem(CLAIMS_KEY) || '{}') as ClaimMap) || {}; } catch { return {}; }
}
function save(m: ClaimMap): void {
  try { localStorage.setItem(CLAIMS_KEY, JSON.stringify(m)); } catch { /* 存满/隐私模式：忽略 */ }
}

/** 记住「这个会（按号 + 标题）属于某群」。两个键都记，命中率更高（号最稳·标题兜底循环会）。 */
export function rememberClaim(opts: { meetingNo?: string | null; topic?: string | null }, workspaceId: string): void {
  if (!workspaceId) return;
  const m = load();
  const no = String(opts.meetingNo || '').trim();
  const t = normTopic(opts.topic);
  if (no) m[`no:${no}`] = workspaceId;
  if (t) m[`topic:${t}`] = workspaceId;
  save(m);
}

/** 撤销「这个会（按号 + 标题）属于某群」的认领映射。只删本会相关键·不影响同群其它会议（可逆移除·M4）。 */
export function forgetClaim(opts: { meetingNo?: string | null; topic?: string | null }): void {
  const m = load();
  let changed = false;
  const no = String(opts.meetingNo || '').trim();
  const t = normTopic(opts.topic);
  if (no && m[`no:${no}`]) { delete m[`no:${no}`]; changed = true; }
  if (t && m[`topic:${t}`]) { delete m[`topic:${t}`]; changed = true; }
  if (changed) save(m);
}

/** 查认领映射：会议号命中优先，否则归一标题。返回 workspace_id 或 ''。 */
export function resolveClaim(opts: { meetingNo?: string | null; topic?: string | null }): string {
  const m = load();
  const no = String(opts.meetingNo || '').trim();
  if (no && m[`no:${no}`]) return m[`no:${no}`];
  const t = normTopic(opts.topic);
  if (t && m[`topic:${t}`]) return m[`topic:${t}`];
  return '';
}

/** 清掉某群的所有认领（群被删时调用·避免悬空映射）。 */
export function forgetClaimsForWorkspace(workspaceId: string): void {
  const m = load();
  let changed = false;
  for (const k of Object.keys(m)) if (m[k] === workspaceId) { delete m[k]; changed = true; }
  if (changed) save(m);
}
