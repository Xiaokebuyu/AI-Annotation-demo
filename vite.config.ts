import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { runReflow, runReflowAi, reflowAiStream, chatStream, runOcrVlm, runExplainImage, runInterpret, runClassifyContext, runReflowVlm } from './server/infer';
import { debugEvent, debugSnapshot } from './server/debug.mjs';
import { runOcrLayout } from './server/ocr-layout-dev.mjs'; // dev-only：扫描页带坐标 OCR（mac_runner），不进生产代理
import { runInterpretHwr } from './server/hwr-dev.mjs';     // dev-only：英文手写识别（OpenVINO 徐方案模型），不进生产代理
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

/** dev-only AI 代理：浏览器 POST /api/* → 网关 → 各识别/重排/对话端点。Key 留服务端。 */
function inferenceProxy(env: Record<string, string>): Plugin {
  return {
    name: 'inkloop-inference-proxy',
    configureServer(server) {
      for (const k of ['LLM_GATEWAY_URL', 'LLM_GATEWAY_KEY', 'LLM_MODEL']) {
        if (env[k] && !process.env[k]) process.env[k] = env[k];
      }
      const post = (path: string, fn: (body: unknown) => Promise<unknown>) =>
        server.middlewares.use(path, (req, res) => {
          if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', async () => {
            const body = Buffer.concat(chunks).toString('utf8'); // 一次性解码：别 `body += chunk`（多字节 UTF-8 跨 chunk 边界会被截断成 → 中文乱码）
            res.setHeader('content-type', 'application/json');
            try {
              res.end(JSON.stringify(await fn(JSON.parse(body))));
            } catch (e) {
              res.statusCode = 502;
              res.end(JSON.stringify({ error: String((e as Error)?.message || e) }));
            }
          });
        });
      // dev-only 调试通道：客户端镜像 inspect → JSONL + 内存环；GET 快照供外部读。
      post('/api/__debug/event', async (b) => debugEvent(b));
      // dev-only：WS3 对接产物落盘——浏览器(IDB 真数据)产 InkSurface artifacts → 写进协作方 .inkloop-smoke-runs/（其 .gitignore 已忽略）供其 validator/demo 读。relName 限相对路径防穿越。
      post('/api/__debug/dump', async (b) => {
        const { relName, data } = b as { relName: string; data: unknown };
        const baseDir = join(process.cwd(), 'ink-surface-sdk-main', '.inkloop-smoke-runs');
        const target = normalize(join(baseDir, relName));
        if (!target.startsWith(baseDir)) throw new Error('relName 越界');
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify(data, null, 2), 'utf8');
        return { ok: true, path: target };
      });
      server.middlewares.use('/api/__debug/snapshot', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
        res.setHeader('content-type', 'application/json');
        try {
          const n = new URL(req.url || '/', 'http://localhost').searchParams.get('n');
          res.end(JSON.stringify(debugSnapshot(n ? Number(n) : 20)));
        } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String((e as Error)?.message || e) })); }
      });

      post('/api/reflow', runReflow);
      post('/api/reflow-ai', runReflowAi);
      // 流式重排：NDJSON chunked——边收模型分组边写回，前端按段渲染。非流式端点(/api/reflow-ai)留给预热/兜底。
      server.middlewares.use('/api/reflow-ai-stream', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('x-accel-buffering', 'no'); // 禁中间层缓冲，保证逐块到达
          try {
            for await (const group of reflowAiStream(JSON.parse(body))) {
              res.write(JSON.stringify(group) + '\n');
            }
            res.end();
          } catch (e) {
            if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: String((e as Error)?.message || e) })); }
            else res.end();
          }
        });
      });
      post('/api/ocr-vlm', runOcrVlm);
      post('/api/ocr-layout', runOcrLayout); // dev-only：扫描页带坐标 OCR → 位置文本层（Phase 2）
      post('/api/interpret-hwr', runInterpretHwr); // dev-only：英文手写识别（OpenVINO 徐方案模型）
      post('/api/explain-image', runExplainImage);
      post('/api/interpret', runInterpret);
      post('/api/classify-context', runClassifyContext);
      post('/api/reflow-vlm', runReflowVlm);

      // 网页对话式聊天（流式·替代退役的 Agent SDK 会话）：客户端持每本书 buffer、整串 messages 传入，
      // 服务端无状态、逐段 text/plain 增量写回。chat/ 面板（P4）消费它。
      server.middlewares.use('/api/chat', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('POST only'); return; }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', async () => {
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.setHeader('cache-control', 'no-cache');
          res.setHeader('x-accel-buffering', 'no');
          try {
            for await (const delta of chatStream(JSON.parse(body))) res.write(delta);
            res.end();
          } catch (e) {
            if (!res.headersSent) { res.statusCode = 502; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ error: String((e as Error)?.message || e) })); }
            else res.end();
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    // 相对基址：安卓 WebViewAssetLoader 从本地 assets 加载 index.html，绝对 /assets/ 路径会错。
    // dev 下相对基址同样工作；public 资产仍服务于根，配合 renderer 的 BASE_URL 相对解析。
    base: './',
    server: { port: 8765, strictPort: true },
    build: {
      target: 'es2022',
      rollupOptions: {
        // 多页：桌面 web=index.html（浏览器）；电纸屏移动版=mobile.html（安卓壳加载这个）。两页共享 pdfjs 等 chunk。
        input: { main: 'index.html', mobile: 'mobile.html' },
        output: {
          // pdfjs-dist 本体(~数百KB)拆出主包，否则 index.js 触发 >500KB 警告。
          // worker(.mjs)本就独立加载，这里拆的是主线程那半。
          manualChunks(id) {
            if (id.includes('node_modules/pdfjs-dist')) return 'pdfjs';
          },
        },
      },
    },
    plugins: [inferenceProxy(env)],
  };
});
