/**
 * dev 处理流水线渲染（web 桌面 console.ts 与移动版 mobile/dev.ts **共用**）：
 *   · pipelineSection —— 有 pipeline 快照时的逐组件「收到什么 → 产出什么」时间线（含图）。
 *   · legacySection   —— 旧轮无快照的兜底：分类器判定 + 蒸馏字段 + 正文/prompt 折叠块。
 * 从 dev/console.ts 原样抽出（class 名不变·CSS 由各宿主页提供：web=styles.css、mobile=mobile.html）。
 */
import { esc } from '../core/escape';
import type { PipelineStage, PipelineStageIO } from '../core/contracts';
import type { PersistedAiTurn, PersistedMark } from '../core/store-format';

const SHAPE_CN: Record<string, string> = { circle: '圈', underline: '划线', highlight: '高亮', arrow: '箭头', margin_note: '手写', stroke: '标记', tap_region: '点选' };
/** 一个 mark 的"识别结果"标签：手写/画/markup + 识别出的文字（识别分类器的产物）。 */
function featureLabel(m: PersistedMark): string {
  const txt = (m.marked_text || '').replace(/\s+/g, ' ').slice(0, 18);
  if (m.feature_type === 'handwriting') return `手写「${txt || '…'}」`;
  if (m.feature_type === 'drawing') return `画${txt ? `「${txt}」` : '（无字）'}`;
  return `${SHAPE_CN[m.scored_type] || '标记'}「${txt || '—'}」`;
}

function ioRows(rows?: PipelineStageIO[]): string {
  if (!rows?.length) return '';
  return rows.map((r) => {
    const val = r.v || '';
    const long = val.length > 64 || val.includes('\n');
    return `<div class="cns-pl-kv"><span class="k">${esc(r.k)}：</span><span class="v${long ? ' long' : ''}">${esc(val || '—')}</span></div>`;
  }).join('');
}
function imgRow(imgs?: Array<{ role: string; thumb: string }>): string {
  if (!imgs?.length) return '';
  return `<div class="cns-pl-imgs">`
    + imgs.map((im) => {
      const safeThumb = /^data:image\//.test(im.thumb) ? esc(im.thumb) : ''; // 只放行本地截图 data:image/ URL + esc，杜绝 src 属性逃逸
      return `<div class="cns-pl-img"><img class="cns-zoom" src="${safeThumb}" alt=""><span>${esc(im.role)}</span></div>`;
    }).join('')
    + `</div>`;
}
/** 一个组件阶段卡：summary（mark 标 + 名 + 状态 + note）+ body（收到 → 图 → 产出）。 */
function stageCard(st: PipelineStage): string {
  const open = (st.stage === 'model' || st.stage === 'inferview') ? ' open' : ''; // 末两步默认展开
  const tag = st.status === 'skipped' ? '<span class="cns-pl-tag skipped">跳过</span>'
    : st.status === 'error' ? '<span class="cns-pl-tag error">出错</span>' : '';
  const markChip = st.mark_ord ? `<span class="cns-pl-mark">mark ${st.mark_ord}·${esc(st.mark_label || '')}</span>` : '';
  return `<details class="cns-pl-stage ${st.status ?? ''}"${open}>`
    + `<summary class="cns-pl-sum">${markChip}<span class="cns-pl-name">${esc(st.label)}</span>${tag}<span class="cns-pl-note">${esc(st.note || '')}</span></summary>`
    + `<div class="cns-pl-body">`
    + (st.input?.length ? `<div class="cns-pl-io"><div class="cns-pl-io-h">↓ 收到（输入）</div>${ioRows(st.input)}</div>` : '')
    + imgRow(st.images)
    + (st.output?.length ? `<div class="cns-pl-io"><div class="cns-pl-io-h out">↑ 产出（输出）</div>${ioRows(st.output)}</div>` : '')
    + `</div></details>`;
}
export function pipelineSection(stages: PipelineStage[]): string {
  return `<div class="cns-sec">处理流水线（逐组件：收到什么 → 产出什么 · ${stages.length} 步）</div>`
    + `<div class="cns-pl">` + stages.map(stageCard).join('') + `</div>`;
}

/** 旧轮（无 pipeline 快照）的兜底展示：保留分类器判定 + 蒸馏字段 + 正文/prompt 折叠块。 */
export function legacySection(t: PersistedAiTurn, markMap: Map<string, PersistedMark>): string {
  const v = t.inference_view;
  const diag = t.diag ?? {};
  const classify = diag.classify
    ? `<div class="cns-kv"><span class="k">上下文分类器：</span>${diag.classify.respond ? '<span class="cns-yes">回应 ✓</span>' : '<span class="cns-no">折叠 ✗</span>'} — ${esc(diag.classify.reason || '')}</div>`
    : `<div class="cns-kv"><span class="k">上下文分类器：</span>未触发（长停顿综合走 idle，无需判定）</div>`;
  const chips = (t.anchor?.mark_ids ?? []).map((id) => markMap.get(id)).filter((m): m is PersistedMark => !!m)
    .map((m) => `<span class="cns-chip">${esc(featureLabel(m))}</span>`).join('');
  const markRow = `<div class="cns-kv"><span class="k">识别（逐 mark）：</span>${chips || '<span class="cns-chip" style="color:var(--hint)">（无 mark 记录）</span>'}</div>`;
  const q = v?.question ? `<div class="cns-kv"><span class="k">手写问：</span>${esc(v.question)}</div>` : '';
  const sentImg = diag.sent_image ? '<span class="cns-yes">有</span>' : '无';
  const ctx = v?.page_context || '';
  const ctxBlock = ctx
    ? `<details class="cns-ctx"><summary><span class="cns-ctx-h">📄 正文块（滑动窗 ${ctx.length} 字）</span><span class="cns-ctx-prev">${esc(ctx.slice(0, 150))}…</span></summary><div class="cns-ctx-body">${esc(ctx)}</div></details>`
    : `<div class="cns-kv"><span class="k">正文块：</span>（无）</div>`;
  const prompt = t.prompt_snapshot || '';
  const promptBlock = `<details class="cns-ctx"><summary><span class="cns-ctx-h">🧾 完整 prompt（${prompt.length} 字）</span><span class="cns-ctx-prev">${esc(prompt.slice(0, 130))}…</span></summary><div class="cns-ctx-body">${esc(prompt || '—')}</div></details>`;
  return `<div class="cns-sec">分类器判定</div>` + classify + markRow
    + `<div class="cns-sec">蒸馏后喂入（inference-view）</div>`
    + `<div class="cns-kv"><span class="k">关系叙事：</span>${esc(v?.narrative || '—')}</div>`
    + `<div class="cns-kv"><span class="k">所标内容：</span>${esc(v?.marked || '—')}</div>`
    + q
    + `<div class="cns-kv"><span class="k">锚点：</span>${t.anchor?.object_refs?.length ?? 0} 对象 / ${t.anchor?.mark_ids?.length ?? 0} 笔 · 随发图：${sentImg}</div>`
    + ctxBlock + promptBlock;
}
