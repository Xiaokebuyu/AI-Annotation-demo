import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { runInference, runReflow, runReflowAi, reflowAiStream, chatStream, runSummarize, runOcrVlm, runExplainImage, runDigest, runInterpret, runInterpretGesture, runReflowVlm } from './server/infer';
import { debugEvent, debugSnapshot } from './server/debug.mjs';

/** dev-only 推理代理：浏览器 POST /api/infer → 网关 → InferenceResult。Key 留服务端。 */
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
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', async () => {
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
      server.middlewares.use('/api/__debug/snapshot', (req, res) => {
        if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
        res.setHeader('content-type', 'application/json');
        try {
          const n = new URL(req.url || '/', 'http://localhost').searchParams.get('n');
          res.end(JSON.stringify(debugSnapshot(n ? Number(n) : 20)));
        } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: String((e as Error)?.message || e) })); }
      });

      post('/api/infer', runInference);
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
      post('/api/summarize', runSummarize);
      post('/api/ocr-vlm', runOcrVlm);
      post('/api/explain-image', runExplainImage);
      post('/api/digest', runDigest);
      post('/api/interpret', runInterpret);
      post('/api/interpret-gesture', runInterpretGesture);
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
    server: { port: 8765, strictPort: true },
    build: { target: 'es2022' },
    plugins: [inferenceProxy(env)],
  };
});
