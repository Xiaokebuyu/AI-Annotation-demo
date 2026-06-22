/**
 * 空间召回（治本·根因 A）。
 *
 * 建图视野只到"上次回复以来"：每次 AI 回复后 session 即清空，已综合的 mark 不再回到内存 session。
 * 于是"空间临近但时间间隔较远"的旧标注——墙上明明画着——对 buildMarkGraph 根本不存在。
 *
 * 本模块在提交时从持久账本(getFoldedMarks)按 **bbox 邻近** 捞回同页的旧 mark，作"回访"上下文
 * 喂进这一轮（projectInferenceView 末尾的回访子句）。三条纪律：
 *   · 只认几何邻近(bbox/包围)——所有 surface 类型 reload-稳定；不认 same_target（对象 id 跨会话不保证）。
 *   · 严格页内——NormBBox 跨页无意义。
 *   · 旧 mark **不进 graph.nodes**——避免污染 marked / anchor / temporal 主链。
 */
import type { NormBBox, PriorNeighbor } from '../core/contracts';
import type { Mark } from '../capture/session';
import { getFoldedMarks } from '../local/store';
import { SPATIAL_NEAR, centerDist } from './mark-graph';
import { pointInPolygon } from './focus';

/** 召回封顶：最多带回 K 条最近的旧标注，避免叙事膨胀。 */
const RECALL_K = 3;

/**
 * 行带感知（治边注）：欧氏中心距对"边注↔同行正文"必然失败——边注在页边、正文在栏中，
 * 光水平栏沟就把距离顶过阈值，哪怕同一行。故加一条"同一阅读行"通道：y 区间重叠（或中心垂直距 < 行高）
 * 即视作同行，改用水平间距判近（给一个比栏沟宽、比整页窄的可达范围），让边注够得着它那行标过的正文。
 */
const ROW_BAND = 0.03;  // 行高量级：中心垂直距 < 此值即同一阅读行（即便 bbox 未重叠）
const ROW_REACH = 0.5;  // 同行水平可达：够跨栏沟到正文，但够不到对侧页边（防误召同行远处）

/** dev 诊断：每个候选旧标注的判定明细（为什么被召回/被拒）。供 telemetry 离线核对"召回为空"的根因。 */
export interface RecallCandDiag {
  text: string;          // 候选 marked_text（截断）
  ft: string;            // feature_type
  bbox: NormBBox;        // 候选 union bbox（看清是"行级矮块"还是"页面级大块"——区分召回几何 vs marked_text 错配）
  h: number;             // bbox 高度（= bbox[3]，行尺度判定用）
  euclid: number;        // 到当前最近一笔的欧氏中心距（min）
  dy: number;            // 纵向中心距（min）——判同行的关键
  dx: number | null;     // 同行时的水平栏间距（非同行=null）
  sameRow: boolean;      // 是否与某当前笔同一阅读行
  verdict: 'proximity' | 'containment' | 'same_row' | 'rejected';
}

const centerOf = (b: NormBBox): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];
const yOverlap = (a: NormBBox, b: NormBBox): number => Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
const sameRow = (a: NormBBox, b: NormBBox): boolean => yOverlap(a, b) > 0 || Math.abs(centerOf(a)[1] - centerOf(b)[1]) < ROW_BAND;

/**
 * 找出同页、空间临近当前 session 的已落库旧 mark（不在当前 session 内）。
 *   关系：当前任一笔笔迹包住旧 mark 中心 → containment；否则中心距 < SPATIAL_NEAR → proximity。
 *   按到最近当前 mark 的距离排序，按文字去重后封顶 RECALL_K。失败/空一律返回 []（不连累闭环）。
 */
export async function findSpatialRecall(docId: string, sessionMarks: Mark[], diag?: RecallCandDiag[]): Promise<PriorNeighbor[]> {
  if (!docId || !sessionMarks.length) return [];
  try {
    const inSession = new Set(sessionMarks.map((m) => m.id));
    const pages = new Set(sessionMarks.map((m) => m.event.page_id));
    const folded = await getFoldedMarks(docId);
    const candidates = folded.filter((p) => p.hmp && !inSession.has(p.mark_id) && pages.has(p.page_id));
    if (!candidates.length) return [];

    // 当前 mark 按页分组——召回严格页内
    const curByPage = new Map<string, Mark[]>();
    for (const m of sessionMarks) {
      const arr = curByPage.get(m.event.page_id) ?? [];
      arr.push(m);
      curByPage.set(m.event.page_id, arr);
    }

    type Rel = 'proximity' | 'containment' | 'same_row';
    const hits: Array<{ dist: number; rel: Rel; text: string; mark_id: string }> = [];
    for (const cand of candidates) {
      const curs = curByPage.get(cand.page_id);
      if (!curs?.length) continue;
      const [cx, cy] = centerOf(cand.bbox);
      // 三条通道取最近：①当前笔迹圈住候选 ②同栏欧氏近 ③同一阅读行水平可达（治边注）
      let bestDist = Infinity;
      let bestRel: Rel = 'proximity';
      let minEuclid = Infinity, minDy = Infinity, srDx = Infinity, anySR = false; // dev 诊断累计
      for (const m of curs) {
        const mb = m.event.geometry.bbox;
        const d = centerDist(mb, cand.bbox);
        if (d < minEuclid) minEuclid = d;
        const dyv = Math.abs(centerOf(mb)[1] - cy);
        if (dyv < minDy) minDy = dyv;
        const sr = sameRow(mb, cand.bbox);
        if (sr) { anySR = true; const dxs = Math.abs(centerOf(mb)[0] - cx); if (dxs < srDx) srDx = dxs; }
        if (pointInPolygon(cx, cy, m.event.stroke_points)) { bestDist = 0; bestRel = 'containment'; } // 圈住=最近
        if (d < SPATIAL_NEAR) { if (d < bestDist) { bestDist = d; bestRel = 'proximity'; } }
        else if (sr) {
          const dx = Math.abs(centerOf(mb)[0] - cx); // 同行 → 只算水平栏间距，纵向已对齐
          if (dx < ROW_REACH && dx < bestDist) { bestDist = dx; bestRel = 'same_row'; }
        }
      }
      if (diag) diag.push({
        text: (cand.marked_text || '').trim().slice(0, 24) || '（无字）', ft: cand.feature_type,
        bbox: cand.bbox.map((n) => +n.toFixed(3)) as NormBBox, h: +cand.bbox[3].toFixed(3),
        euclid: +minEuclid.toFixed(3), dy: +minDy.toFixed(3), dx: srDx === Infinity ? null : +srDx.toFixed(3),
        sameRow: anySR, verdict: bestDist === Infinity ? 'rejected' : bestRel,
      });
      if (bestDist === Infinity) continue; // 三条通道都没近 → 不召回
      hits.push({ dist: bestDist, rel: bestRel, text: (cand.marked_text || '').trim() || '（无字）', mark_id: cand.mark_id });
    }

    hits.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    const out: PriorNeighbor[] = [];
    for (const h of hits) {
      if (seen.has(h.text)) continue; // 同文字旧标注合并一条（保留最近那条的 mark_id）
      seen.add(h.text);
      out.push({ text: h.text, rel: h.rel, mark_id: h.mark_id });
      if (out.length >= RECALL_K) break;
    }
    return out;
  } catch {
    return []; // 召回失败不连累主推理闭环
  }
}
