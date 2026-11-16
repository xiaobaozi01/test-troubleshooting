import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { QueryTools, selectLogRecords, normalizeDockerLogs, redact } from '../src/queries.mjs';
import { HarnessRunner, validateReport } from '../src/harness-runner.mjs';
import catalog from '../fixtures/catalog.json' with { type: 'json' };
const root = path.resolve(import.meta.dirname, '..');
const config = { chat: { groupIds: ['qa'], ownerId: 'me', botId: 'bot' } };
const msg = (id, extra = {}) => ({ id, groupId: 'qa', senderId: 'tester', text: '报错', mentions: ['me'], timestamp: new Date().toISOString(), ...extra });
async function setup(t, runner = { run: async () => ({ kind: 'ask', question: '哪个接口？' }) }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'troubleshoot-test-'));
  const store = await new Store(path.join(directory, 'state.json')).load();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sent = [];
  const chat = { send: async m => { sent.push(m); return { id: `bot-${sent.length}` }; } };
  return { store, sent, coordinator: new Coordinator({ store, chat, runner, config, log: () => {} }) };
}

test('游标与待处理消息一并持久化；重启和重复拉取不会重复建任务', async t => {
  const { store, coordinator } = await setup(t);
  await coordinator.ingest([msg('1')], 'cursor-1');
  const restored = await new Store(store.file).load();
  const next = new Coordinator({ store: restored, config, runner: {}, chat: {} });
  await next.ingest([msg('1')], 'cursor-2');
  assert.equal(Object.keys(restored.data.tasks).length, 1);
  assert.equal(restored.data.cursor, 'cursor-2');
  assert.equal(Object.values(restored.data.tasks)[0].messages.length, 1);
});
test('两人同时反馈分别建任务；引用助手追问归入正确任务；普通群聊不触发', async t => {
  const { store, coordinator } = await setup(t);
  await coordinator.ingest([msg('1'), msg('2'), msg('3', { mentions: [] }), msg('4', { senderId: 'bot' }), msg('5', { groupId: 'other' })], '1');
  assert.equal(Object.keys(store.data.tasks).length, 2);
  await coordinator.workOnce(); await coordinator.flushOutbox();
  await coordinator.ingest([msg('6', { mentions: [], replyTo: 'bot-1', text: '/api/orders' })], '2');
  const first = Object.values(store.data.tasks).find(t => t.rootMessageId === '1');
  assert.equal(first.messages.length, 2);
  assert.equal(first.status, 'queued');
});
test('发送成功但确认丢失后使用同一个幂等键重试，不重复生成报告', async t => {
  let runs = 0;
  const { store, coordinator, sent } = await setup(t, { run: async () => { runs++; return { kind: 'ask', question: '接口？' }; } });
  await coordinator.ingest([msg('1')], '1'); await coordinator.workOnce();
  const keys = new Set(); let attempt = 0;
  coordinator.chat.send = async m => { keys.add(m.idempotencyKey); if (++attempt === 1) throw new Error('response lost'); return { id: 'accepted' }; };
  await coordinator.flushOutbox(); await coordinator.flushOutbox(); await coordinator.workOnce();
  assert.equal(keys.size, 1); assert.equal(runs, 1); assert.equal(store.data.outbox[0].sent, true);
});
test('暂停与结束仅开发账号可执行；暂停保留补充消息，继续后处理', async t => {
  const { store, coordinator } = await setup(t);
  await coordinator.ingest([msg('1')], '1');
  await coordinator.ingest([msg('2', { senderId: 'me', replyTo: '1', mentions: [], text: '/暂停' })], '2');
  const task = Object.values(store.data.tasks)[0]; assert.equal(task.status, 'paused');
  await coordinator.ingest([msg('3', { replyTo: '1', mentions: [], text: '补充信息' })], '3');
  await coordinator.workOnce(); assert.equal(task.messages[0].handled, false);
  await coordinator.ingest([msg('4', { senderId: 'me', replyTo: '1', mentions: [], text: '/继续' })], '4');
  await coordinator.workOnce(); assert.equal(task.messages[0].handled, true);
});
test('失败保留任务并回复故障原因；用户可继续，不默默丢弃', async t => {
  const { store, coordinator } = await setup(t, { run: async () => { throw new Error('模型不可用'); } });
  await coordinator.ingest([msg('1')], '1'); await coordinator.workOnce();
  assert.equal(Object.values(store.data.tasks)[0].status, 'failed');
  assert.match(store.data.outbox[0].text, /模型不可用/);
});
test('日志按请求关联，保留多行 Python 堆栈并排除无关请求', async () => {
  const q = new QueryTools({ root, catalog, mode: 'mock' });
  const result = await q.logFile({ environment: 'test', service: 'stock-service', since: '2026-11-09T01:59:55+08:00', until: '2026-11-09T02:00:05+08:00', traceId: 'demo-order-101' });
  assert.ok(result.lines.some(x => x.text.startsWith('Traceback')));
  assert.ok(result.lines.some(x => x.text.includes('CACHE_NAMESPACE')));
  assert.ok(!result.lines.some(x => x.text.includes('OTHER-SKU')));
});
test('traceId 必须完整匹配；时间窗不允许无时区或超长查询', async () => {
  const result = selectLogRecords('2026-11-09T02:00:00Z ERROR traceId=abc-123 bad\n2026-11-09T02:00:00Z INFO traceId=abc good', { since: '2026-11-09T01:59:00Z', until: '2026-11-09T02:01:00Z', traceId: 'abc' });
  assert.equal(result.length, 1); assert.match(result[0].text, /good/);
  const q = new QueryTools({ root, catalog, mode: 'mock' });
  await assert.rejects(q.logFile({ environment: 'test', service: 'stock-service', since: '2026-11-09T02:00:00', until: '2026-11-09T02:00:05' }), /时区/);
});
test('SSH 命令只查询配置中的容器，恶意名称不会进入远程 Shell', async () => {
  let calls = 0;
  const q = new QueryTools({ root, catalog: { services: [{ id: 's', environment: 'test', host: '-oProxyCommand=evil', container: 'x' }] }, mode: 'ssh', runCommand: async () => { calls++; } });
  await assert.rejects(q.status({ environment: 'test', service: 's' }), /无效/); assert.equal(calls, 0);
});
test('代码读取阻止目录穿越，未验证版本保留标记', async () => {
  const q = new QueryTools({ root, catalog, mode: 'mock' });
  await assert.rejects(q.codeRead({ environment: 'test', service: 'stock-service', file: '../../catalog.json' }), /越出/);
  const result = await q.codeSearch({ environment: 'test', service: 'stock-service', query: 'CACHE_NAMESPACE' });
  assert.equal(result.versionVerified, false); assert.ok(result.matches.length > 0);
});
test('报告不能引用虚构或其他任务的证据 ID', () => {
  const report = { summary: '原因', findings: [{ statement: '事实', evidenceIds: ['E-fake'] }], hypotheses: [], nextSteps: ['验证'], limitations: [] };
  assert.throws(() => validateReport({ evidence: {} }, report), /实际取得/);
  assert.doesNotThrow(() => validateReport({ evidence: { 'E-fake': {} } }, report));
});
test('常见凭证字段在查询结果中脱敏', () => {
  const result = redact('Authorization: Bearer demo-secret\npassword=abc api_key="secret"\nCookie: session=abc');
  assert.ok(!result.includes('demo-secret') && !result.includes('abc') && !result.includes('"secret"'));
});
test('状态文件锁阻止两个实例同时使用同一游标', async t => {
  const { store } = await setup(t); await store.lock();
  const other = await new Store(store.file).load();
  await assert.rejects(other.lock(), /已有排障实例/);
  await store.close();
});
test('Docker 每行时间戳不会切断同一异常的堆栈', () => {
  const logs = normalizeDockerLogs('2026-11-08T18:00:00.001Z 2026-11-09T02:00:00+08:00 ERROR traceId=abc failed\n2026-11-08T18:00:00.002Z Traceback (most recent call last):\n2026-11-08T18:00:00.003Z   File "stock.py", line 1\n2026-11-08T18:00:00.004Z RuntimeError: missing namespace');
  const selected = selectLogRecords(logs, { since: '2026-11-08T17:59:00Z', until: '2026-11-08T18:01:00Z', traceId: 'abc' });
  assert.equal(selected.length, 4); assert.match(selected.at(-1).text, /RuntimeError/);
});
test('查询工具不再受次数预算限制，仍可提交追问', async () => {
  const tools = new Map();
  const runner = new HarnessRunner({ config: {}, queries: { services: () => ({ services: [] }) }, store: { save: async () => {} }, skill: '' });
  const task = { id: 'T-1', evidence: {}, calls: [], actions: {} };
  await runner.register({ tools: { restrict() {}, register: def => tools.set(def.name, def) }, systemPrompt: { section() {} } }, task);
  runner.turns.set(task.id, { message: { id: 'm-1' } });
  const exec = { signal: new AbortController().signal };
  for (let i = 0; i < 5; i++) await tools.get('troubleshoot_services').execute({}, exec);
  const result = await tools.get('troubleshoot_ask').execute({ question: '请补充故障发生时间' }, exec);
  assert.equal(result.accepted, true); assert.equal(task.actions['m-1'].kind, 'ask');
});test('远端日志文件只要求绝对路径，并通过固定 tail 读取', async () => {
  const calls = [];
  const q = new QueryTools({ root: process.cwd(), mode: 'ssh', catalog: { environments: ['test'], hosts: [], services: [], repositoryRoots: [] }, runCommand: async (cmd, args) => { calls.push([cmd, args]); return { stdout: '2026-11-09T03:00:00+08:00 ERROR boom\n' }; } });
  q.service = async () => ({ host: 'qa-order', container: 'order-service' });
  await assert.rejects(q.logFile({ environment: 'test', service: 'order-service', path: 'relative.log' }), /绝对路径/);
  const result = await q.logFile({ environment: 'test', service: 'order-service', path: '/var/log/app/error log.log' });
  assert.ok(result.lines.some(line => /boom/.test(line.text)));
  assert.match(calls[0][1].at(-1), /tail -c 2097152 -- '\/var\/log\/app\/error log\.log'/);
});

test('注册远端日志文件工具，不再注册 docker logs 工具', async () => {
  const tools = new Map();
  const runner = new HarnessRunner({ config, queries: {}, chat: {}, root, skill: '', browser: null, knowledge: null });
  await runner.register({ tools: { restrict() {}, register: def => tools.set(def.name, def) }, systemPrompt: { section() {} } }, { id: 'T-tools', evidence: {}, calls: [] });
  assert.ok(tools.has('troubleshoot_log_file'));
  assert.ok(!tools.has('troubleshoot_logs'));
});


