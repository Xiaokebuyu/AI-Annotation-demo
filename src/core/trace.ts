import { bus } from '../app/state';
import { SESSION_ID } from './ids';

const lines: string[] = [];

export function trace(kind: string, obj: Record<string, unknown>): void {
  lines.push(JSON.stringify({ ts: new Date().toISOString(), kind, ...obj }));
  bus.emit('trace', kind, obj);
}

export function traceCount(): number {
  return lines.length;
}

export function downloadTrace(): void {
  const blob = new Blob([lines.join('\n')], { type: 'application/x-ndjson' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trace_${SESSION_ID}.jsonl`;
  a.click();
  URL.revokeObjectURL(a.href);
}
