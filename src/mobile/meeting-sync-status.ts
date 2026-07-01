/**
 * panel 会议同步「上次成功/失败时间」——纯 localStorage 记录，供设置页展示诊断信息。
 * 独立小文件（不放 meeting.ts/dev.ts 任一方，避免两者互相 import）。
 */
export const PANEL_SYNC_OK_KEY = 'inkloop.panelMeeting.lastOkAt.v1';
export const PANEL_SYNC_ERR_KEY = 'inkloop.panelMeeting.lastErr.v1';

export function notePanelSyncOk(): void {
  localStorage.setItem(PANEL_SYNC_OK_KEY, new Date().toISOString());
  localStorage.removeItem(PANEL_SYNC_ERR_KEY);
}

export function notePanelSyncError(e: unknown): void {
  localStorage.setItem(PANEL_SYNC_ERR_KEY, JSON.stringify({
    at: new Date().toISOString(),
    message: String((e as Error)?.message || e),
  }));
}

export interface PanelSyncStatus {
  lastOkAt: string | null;
  lastErr: { at: string; message: string } | null;
}

/** 读当前同步状态给设置页展示。lastOkAt=null 且 lastErr=null 时表示「尚未同步过」。 */
export function readPanelSyncStatus(): PanelSyncStatus {
  const lastOkAt = localStorage.getItem(PANEL_SYNC_OK_KEY);
  const rawErr = localStorage.getItem(PANEL_SYNC_ERR_KEY);
  let lastErr: PanelSyncStatus['lastErr'] = null;
  if (rawErr) { try { lastErr = JSON.parse(rawErr); } catch { /* 忽略损坏的旧记录 */ } }
  return { lastOkAt, lastErr };
}
