/**
 * 客户端 AI 传输信封：把分散在各调用点的 fetch('/api/...') 样板收口到一处。
 *
 *   - postJson：一次性 JSON POST，失败即抛（!ok 与网络错统一成一条 catch 路径）。
 *   - postNdjson：流式 NDJSON POST，逐行解析后回调，容忍半行/坏行。
 *
 * 只吸收 HTTP 样板（method/headers/序列化/ok 校验/分帧）；**降级语义留给各调用方**
 * （recognize 返默认、reflow 返原值、classify 返 {respond:true}……各不相同，不能一刀切）。
 */

/**
 * 生产/安卓包 API 基址：dev 留空 → 仍走 Vite 的 /api/* 中间件（同源相对路径）。
 * 安卓包构建时注入 `VITE_API_BASE_URL=https://<proxy>`，让 WebView 里的相对 /api/*
 * 指向托管 HTTPS 后端（dev 中间件在静态包里不存在）。
 */
const API_BASE = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '').replace(/\/+$/, '');
function apiUrl(path: string): string {
  if (!API_BASE) return path;                    // dev：同源 /api/*
  if (/^https?:\/\//i.test(path)) return path;   // 已是绝对 URL，原样
  return `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
}

/** 发后不管的 JSON POST（遥测/beacon）：失败静默、不阻塞、不抛。keepalive 让翻页/退出时也能送达。 */
export function postBeacon(url: string, body: unknown): void {
  try {
    void fetch(apiUrl(url), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), keepalive: true,
    }).catch(() => { /* beacon 不在/出错都无所谓 */ });
  } catch { /* 序列化出错也不连累 UI */ }
}

/** 一次性 JSON POST。失败（!resp.ok 或网络错）一律抛错，调用方自行 try/catch 兜底。 */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  const resp = await fetch(apiUrl(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: opts?.signal,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${url} ${resp.status}`);
  return (await resp.json()) as T;
}

/**
 * 流式 NDJSON POST：边收边按 '\n' 切行，逐行 JSON.parse 后调 onLine。
 * 半行先攒着、坏行跳过、收尾处理残行。失败（!ok / 无 body）抛错。
 */
export async function postNdjson<T>(
  url: string,
  body: unknown,
  onLine: (parsed: T) => void,
  opts?: { signal?: AbortSignal },
): Promise<void> {
  const resp = await fetch(apiUrl(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: opts?.signal,
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`${url} ${resp.status}`);
  const consume = (line: string): void => {
    if (!line) return;
    try { onLine(JSON.parse(line) as T); } catch { /* 容忍半行/坏行 */ }
  };
  // 非流式兜底：某些代理/CDN/WebView 会缓冲或剥离流式 body，则一次性读全文按行解析。
  if (!resp.body) {
    const text = await resp.text();
    for (const line of text.split('\n')) consume(line.trim());
    return;
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      consume(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  consume(buf.trim()); // 残行
}
