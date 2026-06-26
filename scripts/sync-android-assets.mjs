/**
 * 把前端构建产物 + 端侧模型同步进安卓工程的 assets/。
 *
 *   node scripts/sync-android-assets.mjs
 *
 * 前置：先 `VITE_API_BASE_URL=https://<proxy> npm run build` 生成 dist/。
 * 结果：android/app/src/main/assets/
 *   ├─ index.html, assets/*, cmaps/, standard_fonts/, sample.pdf   ← 来自 dist/（套壳必需）
 *   └─ models/, dictionaries/                                       ← 来自 APK 解出的端侧资产（Phase 2）
 *
 * WebViewAssetLoader 把 URL /assets/ 映射到本目录，故页面地址是
 *   https://appassets.androidplatform.net/assets/index.html
 */
import { existsSync, rmSync, mkdirSync, cpSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'dist');
const ASSETS = resolve(ROOT, 'android/app/src/main/assets');
// APK 解出的端侧模型/词典（见 端侧ocr方案/extracted_assets）。
const ONDEVICE = resolve(ROOT, '../端侧ocr方案/extracted_assets/assets');

if (!existsSync(DIST)) {
  console.error('✗ dist/ 不存在。先跑：VITE_API_BASE_URL=https://<proxy> npm run build');
  process.exit(1);
}

rmSync(ASSETS, { recursive: true, force: true });
mkdirSync(ASSETS, { recursive: true });
cpSync(DIST, ASSETS, { recursive: true });
console.log('✓ dist → android assets');

if (existsSync(resolve(ONDEVICE, 'models'))) {
  cpSync(resolve(ONDEVICE, 'models'), resolve(ASSETS, 'models'), { recursive: true });
  console.log('✓ models → android assets/models');
}
if (existsSync(resolve(ONDEVICE, 'dictionaries'))) {
  cpSync(resolve(ONDEVICE, 'dictionaries'), resolve(ASSETS, 'dictionaries'), { recursive: true });
  console.log('✓ dictionaries → android assets/dictionaries');
}
console.log('完成。Android Studio 里构建 :app 即可。');
