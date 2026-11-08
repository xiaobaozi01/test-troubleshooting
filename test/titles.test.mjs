import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTitle, ensureTaskTitle, repairTaskTitles } from '../src/titles.mjs';

test('标题包含任务编号和问题摘要，去掉@与截图占位符，按UTF-8字节截断', () => {
  const title = taskTitle({ id: 'T-1234abcd', messages: [{ text: '@开发 测试环境下单失败 [模拟截图]' }] });
  assert.equal(title, '排障 T-1234abcd 测试环境下单失败');
  const long = taskTitle({ id: 'T-1234abcd', messages: [{ text: '故障🚧'.repeat(100) }] });
  assert.ok(Buffer.byteLength(long) <= 80); assert.ok(!long.includes('\ufffd'));
});
test('保留已有标题，包括用户自定义标题；未命名时显式调用标题服务', () => {
  let name = '我改过的标题', writes = 0;
  const ctx = { sessionTitle: { get: () => name ? { title: name } : undefined, rename: (_s, value) => { name = value; writes++; } } };
  const task = { id: 'T-1', messages: [] };
  assert.equal(ensureTaskTitle(ctx, task, {}), false); assert.equal(writes, 0);
  name = null; assert.equal(ensureTaskTitle(ctx, task, {}), true); assert.match(name, /T-1/);
});
test('存储维护先持久化恢复标记，再由后端写入标题；重复维护不改写', async () => {
  const persisted = [{ seq: 0, type: 'user/message', data: { source: { kind: 'qa-chat' } } }];
  let events, queued = [], closed = 0, detached = 0;
  const append = async additions => { for (const event of additions) { assert.equal(event.seq, persisted.length); persisted.push(event); } };
  const ctx = {
    sessions: {
      get() {},
      prepare: (id, options) => { assert.equal(options.eventState, 'detached'); events = [...options.seed, { seq: options.seed.length, type: 'session/end-seed', data: {} }]; return { id }; },
      enter: () => () => detached++, announce() {},
      flush: async () => { await append(queued); queued = []; },
    },
    sessionPersistence: { open: async () => ({ header: {}, read: async () => ({ events: [...persisted] }), append, close: async () => closed++ }) },
    sessionTitle: {
      get: () => events.findLast(e => e.type === 'session/title')?.data,
      rename: (_session, title) => { const event = { seq: events.length, type: 'session/title', data: { title } }; events.push(event); queued.push(event); },
    },
    sessionQuery: { readSession: async () => ({ events }) },
  };
  const task = { id: 'T-1', sessionId: 'owned', started: true, messages: [] };
  assert.equal(await repairTaskTitles(ctx, [task]), 1);
  assert.equal(persisted.length, 3); assert.equal(persisted[1].type, 'session/end-seed'); assert.equal(persisted[2].type, 'session/title');
  assert.equal(await repairTaskTitles(ctx, [task]), 0);
  assert.equal(persisted.length, 3); assert.equal(closed, 2); assert.equal(detached, 1);
});
