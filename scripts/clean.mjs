// 清理构建产物与本地调试日志，供打包/交付前运行（零依赖）。
// 背景：交付 zip 里漏进过 .dev-telemetry.jsonl(823KB) 等调试日志（见审计 §4.10）——
// 这些已 gitignore，但手工 zip 当前目录会带上。打包前先 `npm run clean`。
import { rmSync } from 'node:fs';

const TARGETS = [
  'dist',
  '.dev-telemetry.jsonl',
  '.ab-intent.jsonl',
  'vite.log',
  'android/app/build',
  'android/.gradle',
];

for (const t of TARGETS) {
  try {
    rmSync(t, { recursive: true, force: true });
    console.log(`removed ${t}`);
  } catch (e) {
    console.warn(`skip ${t}: ${e.message}`);
  }
}
