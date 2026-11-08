import test from 'node:test';
import assert from 'node:assert/strict';
import { Coordinator, manualDelivery } from '../src/coordinator.mjs';

const config = { chat: { groupIds: ['qa'], ownerId: 'me', botId: 'me' }, repair: { enabled: true, approvalMode: 'harness' } };
const message = (id, text, senderId = 'tester', extra = {}) => ({ id, groupId: 'qa', senderId, text, mentions: [], ...extra });
function setup() {
  let runs = 0, sends = 0;
  const store = { data: { tasks: {}, seen: {}, outbox: [], cursor: null }, save: async () => {} };
  const c = new Coordinator({ config, store, chat: { send: async () => { sends++; return { id: 'unwanted-send' }; } }, runner: { run: async () => { runs++; return { kind: 'ask', question: '请补充接口和时间' }; } }, log() {} });
  return { c, store, counters: () => ({ runs, sends }) };
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
