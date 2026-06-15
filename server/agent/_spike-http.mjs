/**
 * P3.4 验证:真实 HTTP 往返 /api/agent/turn(用与 vite 中间件相同的 handler 形态)。
 * 用法: node --env-file=.env server/agent/_spike-http.mjs
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { agentTurnEndpoint, agentOpenEndpoint } from './session-manager.mjs';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    res.setHeader('content-type', 'application/json');
    try {
      const fn = req.url.endsWith('/open') ? agentOpenEndpoint : agentTurnEndpoint;
      res.end(JSON.stringify(await fn(JSON.parse(body || '{}'))));
    } catch (e) { res.statusCode = 502; res.end(JSON.stringify({ error: String(e?.message || e) })); }
  });
});

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  const post = (path, payload) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }).then((x) => x.json());
  const image = 'data:image/png;base64,' + readFileSync('/tmp/p1-composite.png').toString('base64');
  try {
    console.log('→ POST /api/agent/open (预热)');
    console.log('  ', JSON.stringify(await post('/api/agent/open', { bookId: 'http-test' })));
    console.log('→ POST /api/agent/turn (标注)');
    const r = await post('/api/agent/turn', { bookId: 'http-test', gestureType: 'circle', pageText: '已经是公元二零三五年了，世情仍然没有变化，人类仍然落后。', focus: '已经是公元二零三五年了', image, modes: ['inspiration'] });
    console.log('  result_type=', r.result_type, '| ms=', r._meta?.ms, '| confidence=', r.confidence);
    console.log('  content=', r.content);
    console.log(r.content ? '✅ HTTP 端点全链路通(预热 + 标注轮)' : '❌ 无内容');
    server.close(); process.exit(r.content ? 0 : 1);
  } catch (e) { console.error('失败:', e?.stack || e); server.close(); process.exit(1); }
});
