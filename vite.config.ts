import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { runInference, runReflow, runSummarize, runOcrVlm } from './server/infer';

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
      post('/api/infer', runInference);
      post('/api/reflow', runReflow);
      post('/api/summarize', runSummarize);
      post('/api/ocr-vlm', runOcrVlm);
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
