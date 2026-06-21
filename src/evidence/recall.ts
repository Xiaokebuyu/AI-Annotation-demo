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

const centerOf = (b: NormBBox): [number, number] => [b[0] + b[2] / 2, b[1] + b[3] / 2];

/**
 * 找出同页、空间临近当前 session 的已落库旧 mark（不在当前 session 内）。
 *   关系：当前任一笔笔迹包住旧 mark 中心 → containment；否则中心距 < SPATIAL_NEAR → proximity。
 *   按到最近当前 mark 的距离排序，按文字去重后封顶 RECALL_K。失败/空一律返回 []（不连累闭环）。
 */
export async function findSpatialRecall(docId: string, sessionMarks: Mark[]): Promise<PriorNeighbor[]> {
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

    const hits: Array<{ dist: number; rel: 'proximity' | 'containment'; text: string }> = [];
    for (const cand of candidates) {
      const curs = curByPage.get(cand.page_id);
      if (!curs?.length) continue;
      const [cx, cy] = centerOf(cand.bbox);
      let minDist = Infinity;
      let enclosed = false;
      for (const m of curs) {
        if (pointInPolygon(cx, cy, m.event.stroke_points)) enclosed = true;
        const d = centerDist(m.event.geometry.bbox, cand.bbox);
        if (d < minDist) minDist = d;
      }
      if (!enclosed && minDist >= SPATIAL_NEAR) continue; // 既没被圈住、也不够近 → 不召回
      hits.push({
        dist: enclosed ? 0 : minDist,
        rel: enclosed ? 'containment' : 'proximity',
        text: (cand.marked_text || '').trim() || '（无字）',
      });
    }

    hits.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    const out: PriorNeighbor[] = [];
    for (const h of hits) {
      if (seen.has(h.text)) continue; // 同文字旧标注合并一条
      seen.add(h.text);
      out.push({ text: h.text, rel: h.rel });
      if (out.length >= RECALL_K) break;
    }
    return out;
  } catch {
    return []; // 召回失败不连累主推理闭环
  }
}
