import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createDeploymentPortal } from '../mock/deployment.mjs';
import { browserGuard, browserOrigins, installBrowserSupport, browserInstructions } from '../src/browser-support.mjs';

test('模拟部署后台要求登录，测试环境与服务明确，配置页面无写入动作', async t => {
  const portal = createDeploymentPortal();
  const server = http.createServer(async (req, res) => {
    if (!await portal.handle(req, res, new URL(req.url, 'http://127.0.0.1'))) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/deployment-audit')).status, 404);
  const first = await fetch(base + '/deploy/config?env=test&service=order-service').then(r => r.text());
  assert.match(first, /登录部署管理平台/); assert.ok(!first.includes('partner-sandobx'));
  const login = await fetch(base + '/deploy/login', { method: 'POST', body: new URLSearchParams({ username: 'demo', password: 'demo-only' }), redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const html = await fetch(base + '/deploy/config?env=test&service=order-service', { headers: { Cookie: cookie } }).then(r => r.text());
  assert.match(html, /partner-sandobx/); assert.match(html, /order-service/); assert.ok(!html.includes('<button'));
  const other = await fetch(base + '/deploy/config?env=staging&service=order-service', { headers: { Cookie: cookie } }).then(r => r.text());
  assert.match(other, /partner-staging/); assert.ok(!other.includes('partner-sandobx'));
  assert.equal(portal.audit.successfulLogins, 1); assert.equal(portal.audit.writes, 0);
});

test('配置了授权站点时只允许该站点；浏览器实例明确绑定，禁用任意脚本和网络改写', () => {
  const backend = { allowedOrigins: ['https://deploy.example.invalid'], browser: 'verified-instance' };
  const invoke = (name, args) => browserGuard({ name, arguments: args }, backend, {});
  assert.equal(invoke('bsk_page', { action: 'navigate', url: 'https://deploy.example.invalid/login' }), undefined);
  assert.match(invoke('bsk_page', { action: 'navigate', url: 'https://unrelated.example.invalid' }), /授权站点/);
  assert.match(invoke('bsk_session', { action: 'start', browser: 'wrong' }), /绑定/);
  assert.match(invoke('bsk_interact', { action: 'evaluate' }), /任意脚本/);
  assert.match(invoke('bsk_inspect', { action: 'debug' }), /网络规则/);
  assert.match(browserGuard({ name: 'bsk_page', arguments: {} }, backend, null), /没有可操作/);
});

test('未配置授权站点时由 Agent 按知识源判断，只拦非 HTTP(S) 和带凭证地址', () => {
  const invoke = (name, args) => browserGuard({ name, arguments: args }, {}, {});
  assert.equal(invoke('bsk_page', { action: 'navigate', url: 'https://deploy.example.invalid/login' }), undefined);
  assert.match(invoke('bsk_page', { action: 'navigate', url: 'javascript:alert(1)' }), /HTTP/);
  assert.match(invoke('bsk_page', { action: 'navigate', url: 'https://user:password@example.invalid' }), /HTTP/);
});

test('授权站点可省略；配置了就必须是无凭证的 HTTP(S) 地址', () => {
  assert.deepEqual(browserOrigins({ allowedOrigins: [] }), []);
  assert.deepEqual(browserOrigins({}), []);
  assert.throws(() => browserOrigins({ allowedOrigins: ['javascript:alert(1)'] }), /HTTP/);
  assert.throws(() => browserOrigins({ allowedOrigins: ['https://user:password@example.invalid'] }), /HTTP/);
});

test('实际页面观察追加可引用的证据；失败与策略阻止结果不会变为事实', async () => {
  let listener;
  const task = { id: 'T-browser', evidence: {}, calls: [] };
  const turns = new Map([[task.id, {}]]);
  installBrowserSupport({ scope: { systemPrompt: { section() {} }, tools: { guard() {} }, on: (_name, fn) => { listener = fn; } }, task, turns, config: { deploymentBackend: { allowedOrigins: ['http://127.0.0.1:4317'] } }, browser: { text: 'native docs' }, store: { save: async () => {} } });
  const result = { isError: false, content: [{ type: 'text', text: 'test/order-service partner.api.base-url=https://partner-sandobx.example.invalid\npassword=fixture-secret' }] };
  const decision = await listener({ name: 'bsk_inspect', arguments: { action: 'observe', session: 'owned' } }, result, async () => ({ kind: 'accept' }));
  assert.match(decision.content.at(-1).text, /E-/);
  assert.equal(Object.keys(task.evidence).length, 1);
  assert.ok(!JSON.stringify(task.evidence).includes('fixture-secret'));
  await listener({ name: 'bsk_inspect', arguments: { action: 'observe' } }, { isError: true }, async () => ({ kind: 'accept' }));
  assert.equal(Object.keys(task.evidence).length, 1);
  const blocked = await listener({ name: 'bsk_inspect', arguments: { action: 'observe' } }, result, async () => ({ kind: 'block', feedback: [] }));
  assert.equal(blocked.kind, 'block'); assert.equal(Object.keys(task.evidence).length, 1);
});
