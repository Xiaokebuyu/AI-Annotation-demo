import { defineConfig } from 'vitest/config';

/** SDK 子路径 → SDK source（与 vite.config 同口径·子路径在前裸名在后）。 */
const sdkPath = (p: string): string => new URL(`../ink-surface-sdk-main/${p}`, import.meta.url).pathname;
const sdkAliases: Record<string, string> = {
  'ink-surface-sdk/knowledge-schema': sdkPath('packages/knowledge-schema/src/index.ts'),
  'ink-surface-sdk/runtime-schema': sdkPath('packages/runtime-schema/src/index.ts'),
  'ink-surface-sdk/surface-model': sdkPath('packages/surface-model/src/index.ts'),
  'ink-surface-sdk/export-core': sdkPath('packages/export-core/src/index.ts'),
  'ink-surface-sdk/adapters/obsidian': sdkPath('packages/adapter-obsidian/src/index.ts'),
  'ink-surface-sdk': sdkPath('src/index.ts'),
};

// 独立于主 vite.config（不加载 inferenceProxy 插件/server 依赖），跑纯逻辑单测。
// 引擎重构（Stage B/C/F）前的安全网：domain/几何/账本等纯函数在此积累覆盖。
export default defineConfig({
  resolve: { alias: sdkAliases },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'server/**/*.test.ts'],
  },
});
