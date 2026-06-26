/**
 * 账本恢复控制器（F3·从 main.ts 抽出）。
 * reload/重开/切实例后，从 SSoT 账本把「内存态」重建出来——纯账本→state 重建，不碰 DOM chrome
 * （doc-loaded class / 书架刷新 / 文件名等留在 main 的 restoreFromLedger 包装里）。
 */
import type { AnnotationEvent, EventType } from '../core/contracts';
import { SCHEMA_VERSION } from '../core/contracts';
import { bus, getActiveContext, strokeMarkIds, type Stroke, type Tool } from '../app/state';
import { openBook, appendMsg } from '../chat/buffer';
import { getFoldedMarks, getBookAiTurns, getPendingMarks } from '../local/store';
import { addMark, type Mark } from '../capture/session';
import type { PersistedMark } from '../core/store-format';
import type { StrokeFeature, ScoredGesture } from '../capture/classify';

/** 持久 mark → 内存 Mark（仅 pending session 重建用）。t 由 abs_timestamp 折回 performance.now 时间线（保关系 gap）。 */
function persistedToMark(pm: PersistedMark, baseT: number, wall: number): Mark {
  const points = pm.strokes.flatMap((s) => s.points);
  const event: AnnotationEvent = {
    event_id: pm.mark_id, trace_id: '', document_id: pm.document_id, page_id: pm.page_id,
    event_type: pm.scored_type as EventType, geometry: { bbox: pm.bbox }, stroke_points: points,
    text_note: null, created_at: pm.created_at, device_id: pm.device_id, session_id: '',
    pointer_type: pm.pointer_type, version: SCHEMA_VERSION,
  };
  const feature: StrokeFeature = {
    type: pm.feature_type, confidence: pm.feature_confidence, scaleRatio: NaN,
    raw: { strokeCount: pm.strokes.length, templateScore: 0, templateType: pm.scored_type as EventType, scaleRatio: NaN, complexity: 0, ocrWorthy: false, tplSpan: 0 },
  };
  const scored: ScoredGesture = { type: pm.scored_type as EventType, score: pm.scored_score };
  return { id: pm.mark_id, event, feature, scored, t: baseT - (wall - pm.abs_timestamp), hmp: pm.hmp, markedText: pm.marked_text };
}

/** 从账本把一本书的内存态重建出来：笔迹(folded marks) + AI 旁注/对话 buffer + pending session(水位线后)。 */
export async function restoreLedgerState(docId: string): Promise<void> {
  const ctx = getActiveContext();
  const gen = ++ctx.restoreGeneration; // 本次恢复代号（P0-5 竞态守卫）
  // 每个 await 后校验：未被同实例的新恢复抢占、且仍是激活实例——否则丢弃迟到结果、直写 capturedCtx 不经 state proxy，
  // 避免「A 恢复未完 → 切到会议 B → A 的账本读返回后清空/写错 B 的笔迹与旁注」。
  const alive = () => ctx.restoreGeneration === gen && getActiveContext() === ctx;

  openBook(docId); // 非阻塞预热每本书对话 buffer

  // 1) 笔迹：折叠后的 mark → strokesByPage（按 page_id）+ 回填 strokeMarkIds（擦/撤仍能定位整 mark）
  const marks = await getFoldedMarks(docId);
  if (!alive()) return;
  ctx.strokesByPage.clear();
  for (const m of marks) {
    const arr = ctx.strokesByPage.get(m.page_id) ?? [];
    for (const ps of m.strokes) {
      const st: Stroke = { tool: ps.tool as Tool, points: ps.points };
      strokeMarkIds.set(st, m.mark_id);
      arr.push(st);
    }
    ctx.strokesByPage.set(m.page_id, arr);
  }

  // 2) AI 旁注 + 对话 buffer：书日志折叠（每 overlay_id 取最新；dismissed/folded 不显示）
  const turns = await getBookAiTurns(docId);
  if (!alive()) return;
  ctx.overlays = [];
  const shown = turns.filter((t) => t.overlay_state !== 'dismissed' && t.overlay_state !== 'folded');
  for (const t of shown) {
    t.overlay.object_refs = t.anchor.object_refs; // 跨视图锚（兼容早于 object_refs 的旧快照）
    ctx.overlays.push(t.overlay);
  }
  for (const t of shown.slice(-3)) { // 仅最近 3 轮进 buffer（与 buffer.ts MAX_TURNS=6 一致）
    appendMsg(docId, { role: 'user', content: t.prompt_snapshot });
    appendMsg(docId, { role: 'assistant', content: t.ai_reply });
  }

  // 3) pending session：水位线之后未综合的 mark 重建进内存 session（下次 idle 仍能综合）
  const pending = await getPendingMarks(docId);
  if (!alive()) return;
  if (pending.length) {
    const baseT = performance.now(), wall = Date.now();
    for (const pm of pending) addMark(docId, persistedToMark(pm, baseT, wall));
  }

  bus.emit('page:rendered'); // 补一次重绘：让 redrawInk/whisper 拿到恢复后的数据
}
