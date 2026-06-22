/**
 * 客户端 AI 传输信封：把分散在各调用点的 fetch('/api/...') 样板收口到一处。
 *
 *   - postJson：一次性 JSON POST，失败即抛（!ok 与网络错统一成一条 catch 路径）。
 *   - postNdjson：流式 NDJSON POST，逐行解析后回调，容忍半行/坏行。
 *
 * 只吸收 HTTP 样板（method/headers/序列化/ok 校验/分帧）；**降级语义留给各调用方**
 * （recognize 返默认、reflow 返原值、classify 返 {respond:true}……各不相同，不能一刀切）。
 */

/** 一次性 JSON POST。失败（!resp.ok 或网络错）一律抛错，调用方自行 try/catch 兜底。 */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  const resp = await fetch(url, {
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
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: opts?.signal,
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) throw new Error(`${url} ${resp.status}`);
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const consume = (line: string): void => {
    if (!line) return;
    try { onLine(JSON.parse(line) as T); } catch { /* 容忍半行/坏行 */ }
  };
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
