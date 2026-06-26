/**
 * 本地向量库（v3 真相源的语义检索层）—— P5 占位接口。
 *
 * 边界要求：模型生成 / 数据库 / 向量存储全部本地直连，**绝不 MCP 化**（MCP 只在外部集成那条缝）。
 * 实现待选型（候选：SQLite + sqlite-vec / DuckDB / 本地 embedding 模型），先占位、no-op。
 * 接上后：S1 标注即可搜、S4 跨材料综合、S6 长期记忆都从这里取底料；durable=真相源、buffer 只是薄缓存。
 */
export interface VectorRecord {
  id: string;
  bookId: string;
  pageIndex: number;
  text: string;            // 判断/标注文本（OCR + 手写转写）
  anchorRefs?: string[];   // HMP target_object_refs —— 检索结果可点回原页（溯源）
}
export interface VectorHit extends VectorRecord { score: number; }

export interface VectorStore {
  /** 真实现=true；占位 stub=false。上游据此区分「功能未实现」与「确实无相关内容」，不静默吞（C6）。 */
  readonly available: boolean;
  upsert(rec: VectorRecord): Promise<void>;
  search(query: string, opts?: { bookId?: string; k?: number }): Promise<VectorHit[]>;
}

/** 占位实现：available=false、不落库、检索恒空。替换为真实本地向量库时只动这一处（接口对上游不变）。 */
export const vectorStore: VectorStore = {
  available: false,
  async upsert() { /* TODO（向量阶段）：本地 embedding + 落库 */ },
  async search() { return []; },
};
