export const uuid = (): string => crypto.randomUUID();

export const shortId = (prefix: string): string => `${prefix}_${uuid().slice(0, 8)}`;

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 稳定页 ID = 完整 documentId 的 32-bit FNV-1a 哈希 + 页号（同步、确定性）。
 *  不再用 documentId.slice(4,12)：会议资料 id 形如 `mtgdoc_<会议>_<消息>`，截断后多份资料同页号会撞同一 pageId，
 *  污染按 pageId 作键的 OCR 层缓存 / anchor / 召回。哈希全 id → 不同资料同页号不再碰撞（B5）。 */
export function pageIdFor(documentId: string, pageIndex: number): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < documentId.length; i++) {
    h ^= documentId.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return `pg_${(h >>> 0).toString(16).padStart(8, '0')}_${pageIndex}`;
}

function persistedDeviceId(): string {
  try {
    const existing = localStorage.getItem('inkloop_device_id');
    if (existing) return existing;
    const id = 'dev_' + uuid().slice(0, 8);
    localStorage.setItem('inkloop_device_id', id);
    return id;
  } catch {
    return 'dev_' + uuid().slice(0, 8); // 无 localStorage（node 测试/SSR/隐私模式）：用临时 id，不在模块加载时崩
  }
}

export const DEVICE_ID = persistedDeviceId();
export const SESSION_ID = 'ses_' + uuid().slice(0, 8);
