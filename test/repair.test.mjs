import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RepairEngine, confirmRepair, planDigest, repairFooter, invalidateRepairs } from '../src/repair.mjs';
import { repairPolicy } from '../src/repair-policy.mjs';
import { createRepairPlatform } from '../mock/repair-platform.mjs';
import { createKnowledgeBase } from '../src/knowledge.mjs';
import { evidence } from '../src/queries.mjs';
import { Coordinator } from '../src/coordinator.mjs';

const old = 'https://partner-sandobx.example.invalid', fixed = 'https://partner-sandbox.example.invalid';
const policy = { environments: ['test'], services: ['order-service'], keys: ['partner.api.base-url'], checks: ['partner-status'], publish: true };
const chatConfig = { chat: { groupIds: ['qa'], ownerId: 'me', botId: 'bot' }, repair: { enabled: true } };
async function fixture() {
  let time = Date.now(), version = 'v1';
  const task = { id: 'T-12345678', groupId: 'qa', evidence: {}, messages: [], calls: [], actions: {} };
  const store = { data: { tasks: { [task.id]: task }, seen: {}, outbox: [] }, save: async () => {} };
  const platform = createRepairPlatform();
  const adapter = { ...platform };
  const knowledge = { read: async () => ({ sourceId: 'approved', documentId: 'runbook', version, repairPolicy: policy, location: 'doc.md' }) };
  const config = { enabled: true, ownerId: 'me', environments: ['test'], allowedSources: ['approved'] };
  const engine = new RepairEngine({ adapter, store, knowledge, config, now: () => time });
  const snapshot = evidence(task, 'repair-snapshot', {}, await engine.snapshot({ environment: 'test', service: 'order-service', keys: ['partner.api.base-url'] }));
  const doc = evidence(task, 'knowledge-document', {}, await knowledge.read());
  const args = { snapshotEvidenceId: snapshot.evidenceId, runbookEvidenceId: doc.evidenceId, changes: [{ key: 'partner.api.base-url', before: old, after: fixed }], checks: ['partner-status'], reason: '代码接入约定、日志与配置证据一致', verification: '新版本状态请求通过', recovery: '停止，保留原值；恢复另出方案确认' };
  const propose = () => engine.propose(task, structuredClone(args), { id: 'original' });
  const approve = plan => {
    store.data.outbox.push({ taskId: task.id, idempotencyKey: `${task.id}:result:${plan.messageId}`, sent: true, messageId: 'proposal' });
    const message = { id: 'owner-confirm', groupId: 'qa', senderId: 'me', replyTo: 'proposal', text: `/确认修复 ${plan.id}` };
    const result = confirmRepair(task, message, store, chatConfig, time);
    assert.equal(result.accepted, true);
    return message;
  };
  return { task, store, engine, config, platform, adapter, knowledge, args, propose, approve, advance: ms => { time += ms; }, changeDocument: () => { version = 'v2'; } };
}

test('没有本人确认时方案不写入；确认只放行原方案，发布后以新配置验证', async () => {
  const f = await fixture(), plan = await f.propose();
  assert.equal(f.platform.count(), 0);
  await assert.rejects(f.engine.execute(f.task, plan.id, { id: 'other' }), /确认/);
  const owner = f.approve(plan);
  const result = await f.engine.execute(f.task, plan.id, owner);
  assert.equal(result.state, 'verified'); assert.equal(f.platform.count(), 1);
  assert.equal(f.platform.configuration('test', 'order-service').values['partner.api.base-url'], fixed);
  assert.equal(f.task.evidence[result.verification.evidenceId].kind, 'repair-verification');
  assert.match(repairFooter(f.task), /修改发布后/); assert.ok(!repairFooter(f.task).includes('未修改'));
  assert.equal((await f.engine.execute(f.task, plan.id, owner)).state, 'verified'); assert.equal(f.platform.count(), 1);
});

test('测试人员、跨群、未引用方案与普通同意均不能确认；重复确认不重新执行', async () => {
  const f = await fixture(), plan = await f.propose();
  const base = { id: 'confirmation', groupId: 'qa', senderId: 'tester', replyTo: 'proposal', text: `/确认修复 ${plan.id}` };
  assert.equal(confirmRepair(f.task, base, f.store, chatConfig).accepted, false);
  assert.equal(confirmRepair(f.task, { ...base, senderId: 'me', groupId: 'other' }, f.store, chatConfig).accepted, false);
  assert.equal(confirmRepair(f.task, { ...base, senderId: 'me' }, f.store, chatConfig).accepted, false);
  assert.equal(confirmRepair(f.task, { ...base, text: '同意' }, f.store, chatConfig), null);
  const owner = f.approve(plan);
  assert.equal(confirmRepair(f.task, { ...owner, id: 'duplicate' }, f.store, chatConfig).accepted, false);
  await assert.rejects(f.engine.execute(f.task, plan.id, { ...owner, senderId: 'tester' }), /确认/);
  assert.equal(f.platform.count(), 0);
});

test('方案被改、确认过期、文档变化、代码变化与平台变化均失效，不写入', async () => {
  for (const change of ['tampered', 'expired', 'document', 'platform', 'code']) {
    const f = await fixture(), plan = await f.propose(), owner = f.approve(plan);
    if (change === 'tampered') plan.changes[0].after = 'https://another.example.invalid';
    if (change === 'expired') f.advance(16 * 60000);
    if (change === 'document') f.changeDocument();
    if (change === 'platform') f.config.platformId = 'different-platform';
    if (change === 'code') f.task.repositorySync = { repositories: [{ repository: 'repo', branch: 'main', commit: 'new-commit' }] };
    if (['tampered', 'platform'].includes(change)) await assert.rejects(f.engine.execute(f.task, plan.id, owner), /确认/);
    else assert.equal((await f.engine.execute(f.task, plan.id, owner)).state, 'stale');
    assert.equal(f.platform.count(), 0);
  }
});

test('配置在确认后变化，不能覆盖别人新配置；写入阶段仍用条件版本', async () => {
  const f = await fixture(), plan = await f.propose(), owner = f.approve(plan);
  await f.platform.apply({ operationId: 'R-111111111111', environment: 'test', service: 'order-service', expectedRevision: '7', changes: [{ key: 'partner.api.timeout-ms', before: 3000, after: 4000 }], publish: true });
  assert.equal((await f.engine.execute(f.task, plan.id, owner)).state, 'stale');
  const c = f.platform.configuration('test', 'order-service');
  assert.equal(c.values['partner.api.base-url'], old); assert.equal(c.values['partner.api.timeout-ms'], 4000);
  await assert.rejects(f.platform.apply({ operationId: 'R-222222222222', environment: 'test', service: 'order-service', expectedRevision: '7', changes: plan.changes, publish: true }), /版本冲突/);
});

test('发布成功但响应丢失，重启后按持久操作号核实，不重复发布', async () => {
  const f = await fixture(), plan = await f.propose(), owner = f.approve(plan);
  const apply = f.adapter.apply;
  f.adapter.apply = async request => { await apply(request); throw new Error('response lost'); };
  assert.equal((await f.engine.execute(f.task, plan.id, owner)).state, 'needs_reconciliation');
  assert.equal(f.platform.count(), 1);
  const engine = new RepairEngine({ adapter: f.platform, knowledge: f.knowledge, config: f.config, store: f.store });
  assert.equal((await engine.execute(f.task, plan.id, owner)).state, 'verified');
  assert.equal(f.platform.count(), 1);
});

test('后续轮次可只读核实未知结果；即使查不到操作也绝不补写', async () => {
  const f = await fixture(), plan = await f.propose(), owner = f.approve(plan);
  const apply = f.adapter.apply;
  f.adapter.apply = async request => { await apply(request); throw new Error('response lost'); };
  await f.engine.execute(f.task, plan.id, owner);
  assert.equal((await f.engine.status(f.task, plan.id)).state, 'verified'); assert.equal(f.platform.count(), 1);
  const g = await fixture(), other = await g.propose(), confirmation = g.approve(other);
  g.adapter.apply = async () => { throw new Error('network error'); };
  await g.engine.execute(g.task, other.id, confirmation);
  assert.equal((await g.engine.status(g.task, other.id)).state, 'stale'); assert.equal(g.platform.count(), 0);
});

test('验证失败不宣称恢复、不擅自回滚，也不重复发布', async () => {
  const f = await fixture();
  f.args.changes[0].after = 'https://still-wrong.example.invalid';
  const plan = await f.propose(), owner = f.approve(plan);
  assert.equal((await f.engine.execute(f.task, plan.id, owner)).state, 'verification_failed');
  assert.match(repairFooter(f.task), /验证未通过/);
  await f.engine.execute(f.task, plan.id, owner);
  assert.equal(f.platform.count(), 1); assert.equal(f.platform.configuration('test', 'order-service').values['partner.api.base-url'], f.args.changes[0].after);
});

test('普通 FAQ、未授权配置键、未知验证项和生产环境不能进入执行范围', async () => {
  const f = await fixture();
  f.knowledge.read = async () => ({ sourceId: 'approved', documentId: 'runbook', version: 'v1', repairPolicy: null });
  await assert.rejects(f.propose(), /授权/);
  const g = await fixture(); g.args.changes[0].key = 'partner.api.timeout-ms';
  await assert.rejects(g.propose(), /范围/);
  const h = await fixture(); h.args.checks = ['arbitrary-http-request'];
  await assert.rejects(h.propose(), /验证项/);
  await assert.rejects(h.engine.snapshot({ environment: 'production', service: 'order-service', keys: ['partner.api.base-url'] }), /测试环境/);
  await assert.rejects(h.engine.snapshot({ environment: 'test', service: 'order-service', keys: ['db.password'] }), /非敏感/);
});

test('暂停或结束撤销尚未执行的确认；新方案取代旧方案', async () => {
  const f = await fixture(), first = await f.propose();
  const next = await f.propose();
  assert.equal(first.state, 'cancelled'); assert.notEqual(first.id, next.id);
  const owner = f.approve(next); invalidateRepairs(f.task, '暂停');
  assert.equal((await f.engine.execute(f.task, next.id, owner)).state, 'cancelled');
  assert.equal(f.platform.count(), 0);
});

test('部署平台持久化幂等记录；失败的存储提交不暴露已发布配置', async () => {
  let saved;
  const first = createRepairPlatform({ persist: async value => { saved = value; } });
  const request = { operationId: 'R-123456789abc', environment: 'test', service: 'order-service', expectedRevision: '7', changes: [{ key: 'partner.api.base-url', before: old, after: fixed }], publish: true };
  const result = await first.apply(request);
  const restored = createRepairPlatform({ state: saved });
  assert.deepEqual(await restored.apply(request), result); assert.equal(restored.count(), 1);
  await assert.rejects(restored.apply({ ...request, expectedRevision: '8' }), /幂等/);
  const failing = createRepairPlatform({ persist: async () => { throw new Error('disk full'); } });
  await assert.rejects(failing.apply(request), /disk full/);
  assert.equal(failing.configuration('test', 'order-service').revision, '7'); assert.equal(failing.count(), 0);
});

test('自然语言手册加小授权块，正文与授权变化均更新版本；拒绝通配权限', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repair-runbook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'runbook.md');
  const content = p => `# 配置修复\n\n\`\`\`repair-policy\n${JSON.stringify(p)}\n\`\`\`\n\n满足条件后先请开发确认。`;
  await writeFile(file, content(policy));
  const kb = await createKnowledgeBase(root, { sources: [{ id: 'approved', path: 'runbook.md' }] });
  const match = (await kb.search({ query: '配置修复' })).documents[0];
  const doc = await kb.read(match); assert.equal(doc.repairPolicy.publish, true); assert.equal(doc.version, match.version);
  await writeFile(file, content({ ...policy, services: ['other-service'] }));
  assert.notEqual((await kb.read(match)).version, doc.version);
  assert.throws(() => repairPolicy('', { ...policy, environments: ['*'] }), /通配符/);
});

test('确认消息经持久队列交回 Agent，本人确认前不调用修复执行', async () => {
  const f = await fixture(), plan = await f.propose();
  let runs = 0;
  const c = new Coordinator({ store: f.store, config: chatConfig, chat: { send: async () => ({ id: 'proposal' }) }, runner: { run: async (_task, message) => { runs++; return { kind: 'ask', question: '确认已交给执行 Agent' }; } } });
  f.store.data.seen['qa:proposal'] = f.task.id;
  f.store.data.outbox.push({ taskId: f.task.id, idempotencyKey: `${f.task.id}:result:${plan.messageId}`, sent: true, messageId: 'proposal' });
  const message = { id: 'tester-confirm', groupId: 'qa', senderId: 'tester', replyTo: 'proposal', mentions: [], text: `/确认修复 ${plan.id}` };
  await c.ingest([message], '1'); await c.workOnce(); assert.equal(runs, 0); assert.equal(plan.state, 'awaiting_confirmation');
  await c.ingest([{ ...message, id: 'owner-confirm', senderId: 'me' }], '2');
  assert.equal(plan.state, 'approved'); await c.workOnce(); assert.equal(runs, 1); assert.equal(f.platform.count(), 0);
});
