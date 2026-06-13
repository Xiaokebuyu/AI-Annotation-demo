export const uuid = (): string => crypto.randomUUID();

export const shortId = (prefix: string): string => `${prefix}_${uuid().slice(0, 8)}`;

export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function persistedDeviceId(): string {
  const existing = localStorage.getItem('inkloop_device_id');
  if (existing) return existing;
  const id = 'dev_' + uuid().slice(0, 8);
  localStorage.setItem('inkloop_device_id', id);
  return id;
}

export const DEVICE_ID = persistedDeviceId();
export const SESSION_ID = 'ses_' + uuid().slice(0, 8);
