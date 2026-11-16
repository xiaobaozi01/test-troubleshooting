import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator } from '../src/coordinator.mjs';

const config = { chat: { groupIds: ['qa'], ownerId: 'me', botId: 'me' } };
const message = (id, text, senderId = 'tester', extra = {}) => ({ id, groupId: 'qa', senderId, text, mentions: [], ...extra });
function setup(runConfig = config) {
  let runs = 0, sends = 0;
  const sent = [];
  const store = { data: { tasks: {}, seen: {}, outbox: [], cursor: null }, save: async () => {} };
  const c = new Coordinator({ config: runConfig, store, chat: { send: async item => { sends++; sent.push(structuredClone(item)); return { id: `sent-${sends}` }; } }, runner: { run: async () => { runs++; return { kind: 'ask', question: '请补充接口和时间' }; } }, log() {} });
  return { c, store, sent, counters: () => ({ runs, sends }) };
}

test('同账号读取测试@，追问自动发回原群', async () => {
  const { c, store, sent, counters } = setup();
  await c.ingest([message('root', '下单出错', 'tester', { mentions: ['me'] })], '1');
  await c.workOnce();
  assert.equal(store.data.outbox.length, 1); assert.match(store.data.outbox[0].text, /请补充/);
  await c.flushOutbox(); assert.deepEqual(counters(), { runs: 1, sends: 1 });
  assert.equal(sent[0].senderId, 'me'); assert.match(sent[0].text, /需要补充信息/);
});

test('本人账号的消息不会再次触发Agent；测试引用追问仍归回原任务', async () => {
  const { c, store, counters } = setup();
  await c.ingest([message('root', '接口报错', 'tester', { mentions: ['me'] })], '1');
  await c.workOnce(); const task = Object.values(store.data.tasks)[0];
  await c.ingest([message('manual-forward', `#${task.id} 请补充接口和时间`, 'me')], '2'); await c.workOnce();
  assert.equal(counters().runs, 1); assert.equal(store.data.seen['qa:manual-forward'], task.id);
  await c.ingest([message('tester-detail', '/api/orders，刚刚发生', 'tester', { replyTo: 'manual-forward' })], '3');
  await c.workOnce(); assert.equal(counters().runs, 2); assert.equal(Object.keys(store.data.tasks).length, 1);
  await c.ingest([message('manual-result', `#${task.id} 修复完成`, 'me', { mentions: ['me'], replyTo: 'root' })], '4'); await c.workOnce();
  assert.equal(counters().runs, 2); assert.equal(task.messages.length, 2);
});

test('最终结果自动发回原群', async () => {
  const { c, store, sent, counters } = setup();
  c.runner.run = async () => ({ kind: 'finish', summary: '问题已定位', findings: [], hypotheses: [], nextSteps: ['按原用例复验'], limitations: ['未操作真实公司环境'] });
  await c.ingest([message('root', '测试报错', 'tester', { mentions: ['me'] })], '1');
  await c.workOnce(); await c.flushOutbox();
  assert.equal(counters().sends, 1); assert.match(sent[0].text, /问题已定位/);
  assert.equal(store.data.outbox[0].sent, true);
});

const report = { kind: 'finish', summary: '已定位缓存配置问题', findings: [], hypotheses: [], nextSteps: ['按原用例复验'], limitations: ['演示环境'] };

test('同账号自动追问、接收引用补充并自动发最终结果，自身回显不触发新排障', async () => {
  const { c, store, sent } = setup(); let runs = 0;
  c.runner.run = async () => ++runs === 1 ? { kind: 'ask', question: '请补充接口和时间' } : report;
  await c.ingest([message('root', '接口报错', 'tester', { mentions: ['me'] })], '1');
  await c.workOnce(); await c.flushOutbox();
  const task = Object.values(store.data.tasks)[0];
  assert.equal(sent[0].senderId, 'me'); assert.match(sent[0].text, /需要补充信息/);
  await c.ingest([message('sent-1', sent[0].text, 'me', { replyTo: 'root', mentions: ['me'], clientMessageId: sent[0].idempotencyKey })], '2');
  await c.workOnce(); assert.equal(runs, 1);
  await c.ingest([message('detail', 'POST /api/orders，刚刚失败', 'tester', { replyTo: 'sent-1' })], '3');
  await c.workOnce(); await c.flushOutbox();
  assert.equal(sent.length, 2); assert.equal(sent[1].senderId, 'me'); assert.match(sent[1].text, /已定位缓存配置/);
  await c.ingest([message('sent-2', sent[1].text, 'me', { replyTo: 'detail' })], '4');
  await c.workOnce(); await c.flushOutbox();
  assert.equal(runs, 2); assert.equal(sent.length, 2); assert.equal(task.messages.length, 2); assert.equal(Object.keys(store.data.tasks).length, 1);
});

test('回显和测试引用先于发送回执到达：按发送关联键或正文任务编号归回原任务', async () => {
  for (const correlation of ['client-key', 'task-number']) {
    const { c, store } = setup();
    await c.ingest([message('root', '报错', 'tester', { mentions: ['me'] })], '1'); await c.workOnce();
    const task = Object.values(store.data.tasks)[0];
    c.chat.send = async item => {
      await c.ingest([
        message('early-echo', correlation === 'client-key' ? '平台调整后的显示文本' : item.text, 'me', correlation === 'client-key' ? { clientMessageId: item.idempotencyKey } : {}),
        message('early-reply', '补充故障时间与接口', 'tester', { replyTo: 'early-echo' }),
      ], '2');
      return { id: 'early-echo' };
    };
    await c.flushOutbox();
    assert.equal(task.messages.length, 2); assert.equal(task.messages[1].id, 'early-reply'); assert.equal(task.status, 'queued');
    assert.equal(store.data.seen['qa:early-echo'], task.id); assert.equal(Object.keys(store.data.tasks).length, 1);
  }
});

test('同账号发送成功但回执丢失：重试用原幂等键，自己的回显不会再次发起排障', async () => {
  const { c, store, counters } = setup();
  await c.ingest([message('root', '报错', 'tester', { mentions: ['me'] })], '1'); await c.workOnce();
  let attempts = 0; const published = new Map();
  c.chat.send = async item => {
    if (!published.has(item.idempotencyKey)) {
      published.set(item.idempotencyKey, 'same-server-id');
      await c.ingest([message('same-server-id', item.text, 'me', { clientMessageId: item.idempotencyKey })], '2');
    }
    if (++attempts === 1) throw new Error('response lost');
    return { id: published.get(item.idempotencyKey) };
  };
  await c.flushOutbox(); await c.workOnce(); await c.flushOutbox();
  assert.equal(attempts, 2); assert.equal(published.size, 1); assert.equal(counters().runs, 1); assert.equal(store.data.outbox[0].sent, true);
});

test('启用自动发送时不放行旧身份或非当前群白名单的发件项', async () => {
  const { c, store, sent } = setup();
  store.data.outbox.push({ groupId: 'other-group', senderId: 'me', sent: false }, { groupId: 'qa', senderId: 'old-bot', sent: false });
  await c.ingest([message('root', '报错', 'tester', { mentions: ['me'] })], '1'); await c.workOnce(); await c.flushOutbox();
  assert.equal(sent.length, 1); assert.equal(sent[0].groupId, 'qa'); assert.equal(sent[0].senderId, 'me');
  assert.ok(store.data.outbox.slice(0, 2).every(item => item.blockedReason && !item.sent));
});

test('追问后的补充消息仍排在队列第一位', async () => {
  const order = [];
  const store = { data: { tasks: {}, seen: {}, outbox: [], cursor: null }, save: async () => {} };
  const c = new Coordinator({ config, store, chat: { send: async () => ({ id: 'sent-1' }) }, runner: { run: async task => { order.push(task.id); return { kind: 'ask', question: '请补充环境' }; } }, log() {} });
  await c.ingest([message('root-a', '接口报错A', 'tester', { mentions: ['me'] })], '1');
  await c.workOnce();
  const a = Object.values(store.data.tasks)[0];
  await c.ingest([message('root-b', '接口报错B', 'tester', { mentions: ['me'] })], '2');
  await c.ingest([message('a-detail', '环境 test，刚刚发生', 'tester', { replyTo: 'root-a' })], '3');
  await c.workOnce();
  assert.deepEqual(order, [a.id, a.id]);
  const b = Object.values(store.data.tasks).find(task => task.id !== a.id);
  assert.equal(b.status, 'queued');
  assert.equal(b.messages.filter(m => !m.handled).length, 1);
});
