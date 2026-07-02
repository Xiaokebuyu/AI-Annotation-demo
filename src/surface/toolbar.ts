import { setTool, state, type Tool } from '../app/state';
import { undoStroke } from '../capture/ink';

const ICONS: Record<string, string> = {
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l.8-3.2L16.2 5.4a2 2 0 0 1 2.8 0l-.4-.4a2 2 0 0 1 0 2.8L7.2 19.2 4 20z"/></svg>',
  aipen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21l.7-2.8L12 9.9l2.1 2.1L5.8 20.3 3 21z"/><path d="M17.5 2.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>',
  highlighter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15l-1 4h8M8.5 14.5l7-7 3 3-7 7h-3v-3z"/><path d="M3 21h18" opacity=".4"/></svg>',
  eraser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16l8.5-8.5a2 2 0 0 1 2.8 0l1.2 1.2a2 2 0 0 1 0 2.8L12 18H8l-2-2z"/><path d="M5 21h14" opacity=".4"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-1.5a1.5 1.5 0 0 1 3 0V12m0-1a1.5 1.5 0 0 1 3 0v4a5 5 0 0 1-5 5h-1.5a4 4 0 0 1-3-1.4L5 16.5a1.5 1.5 0 0 1 2.3-2L8 15.3"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 6L3 10l4 4"/><path d="M3 10h11a6 6 0 1 1 0 12h-4"/></svg>',
};

const TOOLS: Array<{ id: Tool; title: string }> = [
  { id: 'pen', title: '钢笔（圈、划、写 · 纯内容）' },
  { id: 'aipen', title: 'AI 笔（写给 AI / 圈点提问 · 唯一进 AI 的笔）' },
  { id: 'highlighter', title: '高亮' },
  { id: 'eraser', title: '橡皮（点击笔迹删除）' },
  { id: 'hand', title: '手型（拖动 / 横滑翻页；鼠标用，触屏直接手指）' },
];

export function initToolbar(container: HTMLElement): void {
  const btns = new Map<Tool, HTMLButtonElement>();

  for (const t of TOOLS) {
    const btn = document.createElement('button');
    btn.title = t.title;
    btn.innerHTML = ICONS[t.id];
    btn.addEventListener('click', () => {
      setTool(t.id);
      btns.forEach((b, id) => b.classList.toggle('active', id === t.id));
    });
    btns.set(t.id, btn);
    container.appendChild(btn);
  }
  btns.get(state.tool)?.classList.add('active');

  const sep = document.createElement('span');
  sep.className = 'tb-sep';
  container.appendChild(sep);

  const undoBtn = document.createElement('button');
  undoBtn.title = '撤销最后一笔';
  undoBtn.innerHTML = ICONS.undo;
  undoBtn.addEventListener('click', () => undoStroke());
  container.appendChild(undoBtn);
}
