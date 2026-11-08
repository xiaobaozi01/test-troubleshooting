import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeploymentPortal } from './deployment.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.MOCK_PORT ?? 4317);
const deployment = createDeploymentPortal();
const file = path.join(root, '.local/mock-chat.json');
await mkdir(path.dirname(file), { recursive: true });
let data = { sequence: 0, messages: [], replies: {} };
try { data = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
let writes = Promise.resolve();
const save = () => {
  const snapshot = JSON.stringify(data, null, 2);
  writes = writes.then(async () => { await writeFile(`${file}.tmp`, snapshot, { mode: 0o600 }); await rename(`${file}.tmp`, file); });
  return writes;
};
const json = (res, value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let text = '';
  for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32000) throw new Error('消息过大'); }
  return JSON.parse(text || '{}');
}
function message(input, senderId) {
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 16000) throw new Error('消息不能为空或过长');
  if (input.mentions && (!Array.isArray(input.mentions) || !input.mentions.every(x => typeof x === 'string'))) throw new Error('@信息格式错误');
  if (input.groupId && input.groupId !== 'qa-test') throw new Error('模拟接口只支持 qa-test 群');
  return { id: `m-${++data.sequence}`, sequence: data.sequence, groupId: 'qa-test', senderId, mentions: input.mentions ?? [], text: input.text, timestamp: new Date().toISOString(), replyTo: input.replyTo ?? null, attachments: input.attachments ?? [] };
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return json(res, { error: 'invalid host' }, 403);
    const origin = req.headers.origin;
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) return json(res, { error: 'invalid origin' }, 403);
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (await deployment.handle(req, res, url)) return;
    if (req.method === 'GET' && url.pathname === '/deployment-audit') return json(res, deployment.audit);
    if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(await readFile(path.join(root, 'mock/index.html'))); }
    if (req.method === 'GET' && url.pathname === '/messages') {
      const after = url.searchParams.get('after');
      if (after === 'latest') return json(res, { messages: [], nextCursor: String(data.sequence) });
      if (!/^\d+$/.test(after ?? '')) return json(res, { error: 'invalid cursor' }, 400);
      const messages = data.messages.filter(x => x.sequence > Number(after)).slice(0, 100);
      return json(res, { messages, nextCursor: String(messages.at(-1)?.sequence ?? after) });
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const input = await body(req);
      const m = message(input, input.senderId === 'developer-me' ? 'developer-me' : 'tester');
      data.messages.push(m); await save(); return json(res, m);
    }
    if (req.method === 'POST' && url.pathname === '/replies') {
      const input = await body(req);
      if (typeof input.idempotencyKey !== 'string' || !input.idempotencyKey) throw new Error('需要 idempotencyKey');
      if (data.replies[input.idempotencyKey]) return json(res, { id: data.replies[input.idempotencyKey] });
      const m = message(input, 'troubleshooting-bot');
      data.messages.push(m); data.replies[input.idempotencyKey] = m.id;
      await save(); return json(res, { id: m.id });
    }
    if (req.method === 'GET' && url.pathname === '/attachments/demo-error') {
      return json(res, { mediaType: 'image/png', data: (await readFile(path.join(root, 'fixtures/error-screen.png'))).toString('base64') });
    }
    if (req.method === 'GET' && url.pathname === '/snapshot') {
      let runtime = { ready: false }, state = { tasks: {} };
      try { runtime = JSON.parse(await readFile(path.join(root, '.local/runtime.json'), 'utf8')); } catch {}
      try { state = JSON.parse(await readFile(path.join(root, '.local/tasks.json'), 'utf8')); } catch {}
      try { if (runtime.pid) process.kill(runtime.pid, 0); } catch { runtime.ready = false; runtime.stopped = true; }
      return json(res, { messages: data.messages, runtime, tasks: Object.values(state.tasks) });
    }
    if (req.method === 'GET' && url.pathname === '/error-screen') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<html lang="zh-CN"><meta charset="utf-8"><style>body{font:18px system-ui;background:#f3f5f8;padding:48px;color:#253248}.card{background:white;padding:32px;border-radius:16px;max-width:600px}b{color:#b63838}small{color:#68788e}</style><div class="card"><small>模拟商城 · 测试环境</small><h1>提交订单</h1><p>商品 SKU-DEMO-1　数量 1</p><hr><p><b>提交失败，请稍后重试</b></p><p>错误码：ORDER_CREATE_FAILED</p><small>这是模拟报错截图，仅用于排障插件调试。</small></div></html>');
    }
    json(res, { error: 'not found' }, 404);
  } catch (e) { json(res, { error: e.message }, 400); }
});
server.listen(port, '127.0.0.1', () => console.log(`模拟测试群：http://127.0.0.1:${port}`));
for (const event of ['SIGTERM', 'SIGINT']) process.on(event, () => server.close());
