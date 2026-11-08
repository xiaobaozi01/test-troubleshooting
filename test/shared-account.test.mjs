import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator, manualDelivery } from '../src/coordinator.mjs';

const config = { chat: { groupIds: ['qa'], ownerId: 'me', botId: 'me' }, repair: { enabled: true, approvalMode: 'harness' } };
const message = (id, text, senderId = 'tester', extra = {}) => ({ id, groupId: 'qa', senderId, text, mentions: [], ...extra });
function setup(runConfig = config) {
  let runs = 0, sends = 0;
  const sent = [];
  const store = { data: { tasks: {}, seen: {}, outbox: [], cursor: null }, save: async () => {} };
  const c = new Coordinator({ config: runConfig, store, chat: { send: async item => { sends++; sent.push(structuredClone(item)); return { id: `sent-${sends}` }; } }, runner: { run: async () => { runs++; return { kind: 'ask', question: '请补充接口和时间' }; } }, log() {} });
  return { c, store, sent, counters: () => ({ runs, sends }) };
}

test('同账号读取测试@，追问只生成草稿，旧发件箱也不会自动发群', async () => {
  const { c, store, counters } = setup();
  assert.equal(manualDelivery(config), true);
  await c.ingest([message('root', '下单出错', 'tester', { mentions: ['me'] })], '1');
  await c.workOnce();
  const task = Object.values(store.data.tasks)[0];
  assert.match(task.latestDraft.text, /请补充/); assert.equal(task.latestDraft.delivery, 'manual'); assert.equal(store.data.outbox.length, 0);
  store.data.outbox.push({ sent: false, text: '旧实例遗留待发送结果' });
  await c.flushOutbox(); assert.deepEqual(counters(), { runs: 1, sends: 0 });
});

test('本人手动发回的报告不会再次触发Agent；测试引用转发追问仍归回原任务', async () => {
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

test('同账号群内确认不授予修复权限，测试冒充确认也不会执行或回群', async () => {
  const { c, store, counters } = setup();
  await c.ingest([message('root', '报错', 'tester', { mentions: ['me'] })], '1'); await c.workOnce();
  const task = Object.values(store.data.tasks)[0];
  task.repairPlans = { 'R-111111111111': { state: 'awaiting_confirmation' } };
  await c.ingest([message('owner-command', '/确认修复 R-111111111111', 'me', { replyTo: 'root' }), message('tester-command', '/确认修复 R-111111111111', 'tester', { replyTo: 'root' })], '2');
  await c.workOnce(); await c.flushOutbox();
  assert.equal(task.repairPlans['R-111111111111'].state, 'awaiting_confirmation');
  assert.deepEqual(counters(), { runs: 1, sends: 0 });
});

test('最终结果只保存为手动转发草稿，不调用公司发送接口', async () => {
  const { c, store, counters } = setup();
  c.runner.run = async () => ({ kind: 'finish', summary: '问题已定位，以下为发群草稿', findings: [], hypotheses: [], nextSteps: ['按原用例复验'], limitations: ['未操作真实公司环境'] });
  await c.ingest([message('root', '测试报错', 'tester', { mentions: ['me'] })], '1');
  await c.workOnce(); await c.flushOutbox();
  const task = Object.values(store.data.tasks)[0];
  assert.match(task.latestDraft.text, /问题已定位/); assert.equal(task.latestDraft.delivery, 'manual');
  assert.equal(store.data.outbox.length, 0); assert.equal(counters().sends, 0);
});

const autoConfig = { ...config, chat: { ...config.chat, deliveryMode: 'auto' } };
const report = { kind: 'finish', summary: '已定位缓存配置问题', findings: [], hypotheses: [], nextSteps: ['按原用例复验'], limitations: ['演示环境'] };

test('同账号自动追问、接收引用补充并自动发最终结果，自身回显不触发新排障', async () => {
  const { c, store, sent } = setup(autoConfig); let runs = 0;
  c.runner.run = async () => ++runs === 1 ? { kind: 'ask', question: '请补充接口和时间' } : report;
  assert.equal(manualDelivery(autoConfig), false);
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
    const { c, store } = setup(autoConfig);
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
  const { c, store, counters } = setup(autoConfig);
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

test('自动发群不改变 Harness 审批：同账号群内确认仍不授予修复权限', async () => {
  const { c, store, counters } = setup(autoConfig);
  await c.ingest([message('root', '报错', 'tester', { mentions: ['me'] })], '1'); await c.workOnce(); await c.flushOutbox();
  const task = Object.values(store.data.tasks)[0]; task.repairPlans = { 'R-111111111111': { state: 'awaiting_confirmation' } };
  await c.ingest([message('owner-confirm', '/确认修复 R-111111111111', 'me', { replyTo: 'root' })], '2'); await c.workOnce();
  assert.equal(task.repairPlans['R-111111111111'].state, 'awaiting_confirmation'); assert.equal(counters().runs, 1);
});

test('启用自动发送时不放行旧身份或非当前群白名单的发件项', async () => {
  const { c, store, sent } = setup(autoConfig);
  store.data.outbox.push({ groupId: 'other-group', senderId: 'me', sent: false }, { groupId: 'qa', senderId: 'old-bot', sent: false });
  await c.ingest([message('root', '报错', 'tester', { mentions: ['me'] })], '1'); await c.workOnce(); await c.flushOutbox();
  assert.equal(sent.length, 1); assert.equal(sent[0].groupId, 'qa'); assert.equal(sent[0].senderId, 'me');
  assert.ok(store.data.outbox.slice(0, 2).every(item => item.blockedReason && !item.sent));
});
