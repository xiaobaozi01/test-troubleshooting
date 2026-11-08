import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { evidence, redact } from './queries.mjs';

const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const codeVersion = task => createHash('sha256').update(JSON.stringify((task.repositorySync?.repositories ?? []).map(r => [r.repository ?? r.root ?? r.path, r.branch, r.commit]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest('hex');
const payload = p => ({ id: p.id, platform: p.platform, messageId: p.messageId, environment: p.environment, service: p.service, revision: p.revision, changes: p.changes, checks: p.checks, reason: p.reason, verification: p.verification, recovery: p.recovery, basis: p.basis, createdAt: p.createdAt, expiresAt: p.expiresAt });
export const planDigest = p => createHash('sha256').update(JSON.stringify(payload(p))).digest('hex');
const keyName = k => typeof k === 'string' && /^[a-zA-Z_][a-zA-Z0-9_.-]{0,199}$/.test(k) && !/password|passwd|secret|token|credential|private.?key|api.?key/i.test(k) && !['__proto__', 'constructor', 'prototype'].some(s => k.split('.').includes(s));
function scalar(value) {
  if (value !== null && !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) return false;
  if (typeof value === 'string') {
    if (value.length > 2000 || redact(value) !== value) return false;
    if (/^https?:\/\//.test(value)) { try { const url = new URL(value); if (url.username || url.password) return false; } catch { return false; } }
  }
  return true;
}

export function confirmRepair(task, message, store, config, now = Date.now()) {
  const match = /^\/确认修复 (R-[a-f0-9]{12})$/.exec(message.text.trim());
  if (!match) return null;
  const plan = task.repairPlans?.[match[1]];
  const refuse = text => ({ accepted: false, text });
  if (config.repair?.approvalMode !== 'chat') return refuse('修复确认在 Harness 会话的一次性审批卡片中完成，群消息不授予执行权限。');
  if (message.groupId !== task.groupId) return refuse('确认消息不属于本任务所在群。');
  if (message.senderId !== config.chat.ownerId) return refuse('只有被 @ 的开发本人可以确认修复。');
  if (!config.repair?.enabled || !plan || plan.state !== 'awaiting_confirmation') return refuse('没有对应的待确认修复方案；已确认、已执行或失效的方案不能重复确认。');
  const proposal = store.data.outbox.find(x => x.taskId === task.id && x.idempotencyKey === `${task.id}:result:${plan.messageId}` && x.sent);
  if (!proposal || message.replyTo !== proposal.messageId) return refuse('请引用该修复方案的群消息，再发送完整确认指令。');
  if (plan.digest !== planDigest(plan) || now >= Date.parse(plan.expiresAt)) { plan.state = 'stale'; return refuse('方案已变更或过期，请重新生成并确认。'); }
  plan.state = 'approved';
  plan.approval = { ownerId: message.senderId, messageId: message.id, groupId: message.groupId, digest: plan.digest, confirmedAt: new Date(now).toISOString() };
  return { accepted: true, planId: plan.id };
}

export function invalidateRepairs(task, reason) {
  for (const p of Object.values(task.repairPlans ?? {})) {
    if (['awaiting_confirmation', 'approved'].includes(p.state)) { p.state = 'cancelled'; p.cancellation = reason; }
    else if (['executing', 'needs_reconciliation'].includes(p.state)) p.cancelRequested = true;
  }
}

export class RepairEngine {
  constructor({ adapter, knowledge, config, store, now = Date.now }) {
    Object.assign(this, { adapter, knowledge, config, store, now }); this.running = new Map();
    this.harnessGrants = new WeakSet();
  }
  target(environment, service) {
    if (!this.config.enabled || !this.config.environments?.includes(environment) || typeof service !== 'string' || !/^[a-zA-Z0-9_.-]{1,200}$/.test(service)) throw new Error('目标不在已启用的测试环境修复范围');
  }
  async snapshot({ environment, service, keys }, signal) {
    this.target(environment, service);
    if (!Array.isArray(keys) || !keys.length || keys.length > 10 || !keys.every(keyName) || new Set(keys).size !== keys.length) throw new Error('只支持明确列出的非敏感配置键，最多10项');
    const data = await this.adapter.read({ environment, service, keys }, signal);
    if (typeof data?.revision !== 'string' || !data.revision || typeof data.values !== 'object' || !data.values || !keys.every(k => Object.hasOwn(data.values, k) && scalar(data.values[k])) || !Array.isArray(data.checks)) throw new Error('部署适配器快照缺少版本、配置值或验证项');
    return { environment, service, revision: data.revision, activeRevision: typeof data.activeRevision === 'string' ? data.activeRevision : null, values: Object.fromEntries(keys.map(k => [k, data.values[k]])), checks: data.checks.filter(c => typeof c?.id === 'string' && typeof c.description === 'string').map(c => ({ id: c.id, description: redact(c.description).slice(0, 500) })).slice(0, 30), observedAt: new Date(this.now()).toISOString() };
  }
  async propose(task, args, message, signal) {
    const snapshot = task.evidence[args.snapshotEvidenceId];
    const doc = task.evidence[args.runbookEvidenceId];
    if (snapshot?.kind !== 'repair-snapshot' || doc?.kind !== 'knowledge-document') throw new Error('需要本任务实际取得的配置快照和文档正文证据');
    const current = snapshot.result, runbook = doc.result;
    this.target(current.environment, current.service);
    if (!this.config.allowedSources?.includes(runbook.sourceId)) throw new Error('文档不在管理员授权的修复知识源中');
    const fresh = await this.knowledge.read({ sourceId: runbook.sourceId, documentId: runbook.documentId }, signal);
    const policy = fresh.repairPolicy;
    if (fresh.version !== runbook.version || !policy?.publish || !policy.environments.includes(current.environment) || !policy.services.includes(current.service)) throw new Error('文档版本或修复授权不匹配，请重新读取；普通 FAQ 不能授权执行');
    if (this.now() - Date.parse(current.observedAt) > 5 * 60000) throw new Error('配置快照过期，请重新读取');
    if (!Array.isArray(args.changes) || !args.changes.length || args.changes.length > 10 || new Set(args.changes.map(c => c.key)).size !== args.changes.length) throw new Error('需要1–10个不同配置键的精确修改');
    const changes = args.changes.map(c => {
      if (!keyName(c.key) || !policy.keys.includes(c.key) || !Object.hasOwn(current.values, c.key) || !scalar(c.before) || !scalar(c.after) || !equal(c.before, current.values[c.key]) || equal(c.before, c.after)) throw new Error('修改键、修改前值或修改后值不符合快照及文档范围');
      return { key: c.key, before: c.before, after: c.after };
    }).sort((a, b) => a.key.localeCompare(b.key));
    if (!Array.isArray(args.checks) || !args.checks.length || !args.checks.every(id => policy.checks.includes(id) && current.checks.some(c => c.id === id))) throw new Error('必须选择文档和平台均支持的只读验证项');
    for (const field of ['reason', 'verification', 'recovery']) if (typeof args[field] !== 'string' || !args[field].trim() || args[field].length > 2000 || redact(args[field]) !== args[field]) throw new Error('需要非敏感的修复依据、验证和失败处理说明');
    if (Object.values(task.repairPlans ?? {}).some(p => ['executing', 'needs_reconciliation'].includes(p.state))) throw new Error('先核实之前的执行状态，不创建可能覆盖它的新方案');
    invalidateRepairs(task, '已被新方案替代');
    const plan = { id: `R-${randomUUID().replaceAll('-', '').slice(0, 12)}`, platform: this.config.platformId ?? 'test-adapter', environment: current.environment, service: current.service, revision: current.revision, changes, checks: [...new Set(args.checks)].sort(), reason: args.reason, verification: args.verification, recovery: args.recovery, basis: { snapshotEvidenceId: args.snapshotEvidenceId, runbookEvidenceId: args.runbookEvidenceId, sourceId: runbook.sourceId, documentId: runbook.documentId, version: runbook.version, location: runbook.location, codeVersion: codeVersion(task) }, createdAt: new Date(this.now()).toISOString(), expiresAt: new Date(this.now() + 15 * 60000).toISOString(), messageId: message.id, state: 'awaiting_confirmation' };
    plan.digest = planDigest(plan);
    (task.repairPlans ??= {})[plan.id] = plan;
    await this.store.save();
    return plan;
  }
  async executeInHarness(task, planId, message, context) {
    const plan = task.repairPlans?.[planId];
    if (this.config.approvalMode !== 'harness' || !plan || plan.platform !== (this.config.platformId ?? 'test-adapter') || plan.digest !== planDigest(plan) || context.agent?.session?.id !== task.sessionId || typeof context.callId !== 'string' || !context.callId) throw new Error('需要本任务真实 Harness 工具调用中的一次性审批');
    this.target(plan.environment, plan.service);
    if (plan.attemptedAt) return this.status(task, planId, context.signal);
    if (plan.state !== 'awaiting_confirmation') return { planId, state: plan.state, note: '该方案不能重复发起审批；请核实状态或生成新方案。' };
    if (this.now() >= Date.parse(plan.expiresAt)) { plan.state = 'stale'; await this.store.save(); return { planId, state: plan.state, note: '方案已过期，需要重新审阅确认。' }; }
    const digest = plan.digest;
    task.status = 'awaiting_confirmation';
    plan.approvalRequestedAt = new Date(this.now()).toISOString();
    await this.store.save();
    const remaining = Math.max(1, Date.parse(plan.expiresAt) - this.now());
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining);
    let outcome = 'unavailable';
    context.waiting?.(true);
    try {
      outcome = await context.request?.({ agent: context.agent, toolName: 'troubleshoot_repair_execute', callId: context.callId, reason: formatRepairPlan(task.id, plan, 'harness'), signal }) ?? 'unavailable';
    } catch (e) { plan.approvalError = redact(e.message); }
    finally { context.waiting?.(false); }
    plan.approvalOutcome = outcome;
    if (outcome !== 'allowed-once' || signal.aborted || digest !== planDigest(plan) || plan.state !== 'awaiting_confirmation' || plan.cancelRequested || this.now() >= Date.parse(plan.expiresAt)) {
      if (plan.state === 'awaiting_confirmation') plan.state = outcome === 'allowed-once' ? 'stale' : 'cancelled';
      await this.store.save();
      return { planId, state: plan.state, approvalOutcome: outcome, note: '没有取得当前方案的有效一次性审批，未执行修改或发布；不要自动重试审批。' };
    }
    const grant = Object.freeze({ planId, digest, sessionId: task.sessionId, callId: context.callId });
    this.harnessGrants.add(grant);
    plan.state = 'approved';
    plan.approval = { channel: 'harness', ownerId: this.config.ownerId, digest, sessionId: task.sessionId, callId: context.callId, confirmedAt: new Date(this.now()).toISOString() };
    await this.store.save();
    try { return await this.execute(task, planId, message, signal, grant); }
    finally { this.harnessGrants.delete(grant); }
  }
  async execute(task, planId, message, signal, grant) {
    const plan = task.repairPlans?.[planId];
    const local = this.config.approvalMode === 'harness';
    const authority = local
      ? this.harnessGrants.has(grant) && grant.planId === planId && grant.digest === plan?.digest && grant.sessionId === task.sessionId && plan?.approval?.channel === 'harness' && plan.approval.callId === grant.callId
      : this.config.approvalMode === 'chat' && plan?.approval?.ownerId === this.config.ownerId && message.senderId === this.config.ownerId && message.groupId === task.groupId && plan.approval.messageId === message.id && plan.approval.groupId === task.groupId;
    if (!plan || plan.platform !== (this.config.platformId ?? 'test-adapter') || plan.digest !== planDigest(plan) || !plan.approval || plan.approval.digest !== plan.digest || !authority) throw new Error('本轮没有开发本人对该平台和精确方案的有效确认');
    if (local) this.harnessGrants.delete(grant);
    this.target(plan.environment, plan.service);
    if (['verified', 'verification_failed', 'stale', 'cancelled'].includes(plan.state)) return { planId, state: plan.state, verification: plan.verificationResult ?? null, note: '该方案不会再次写入；失败或变更需要重新出方案并确认。' };
    const target = `${plan.environment}/${plan.service}`;
    if (this.running.has(target)) throw new Error('该服务正在执行其他修复，请稍后核实状态');
    const pending = this.perform(task, plan, signal);
    this.running.set(target, pending);
    try { return await pending; } finally { this.running.delete(target); }
  }
  async status(task, planId, signal) {
    const plan = task.repairPlans?.[planId];
    if (!plan || plan.digest !== planDigest(plan) || plan.platform !== (this.config.platformId ?? 'test-adapter')) throw new Error('不存在可核实的原平台方案');
    this.target(plan.environment, plan.service);
    if (!plan.attemptedAt) return { planId, state: plan.state, note: '没有写入尝试；此工具不会修改或发布。' };
    const target = `${plan.environment}/${plan.service}`;
    if (this.running.has(target)) return { planId, state: 'executing', note: '同一服务仍有操作执行中，请稍后核实。' };
    const pending = this.perform(task, plan, signal, true);
    this.running.set(target, pending);
    try { return await pending; } finally { this.running.delete(target); }
  }
  async perform(task, plan, signal, readOnly = false) {
    try {
      let operation;
      // An intent is persisted before side effects. Retried turns reconcile by the same operation id.
      if (plan.attemptedAt) operation = await this.adapter.getOperation({ operationId: plan.id }, signal);
      else operation = { state: 'not_found' };
      if (operation?.state !== 'published' && operation?.state !== 'not_found') throw new Error(`平台执行状态为 ${redact(String(operation?.state ?? 'unknown')).slice(0, 100)}，需人工核实；不盲目再次发布`);
      if (operation.state === 'not_found') {
        if (readOnly) { plan.state = 'stale'; throw new Error('平台未查到该操作；核实工具不会重试写入。如仍需修改，重新出方案并确认'); }
        if ((plan.applyAttempts ?? 0) >= 2) { plan.state = 'stale'; throw new Error('已达到同一方案的写入尝试上限，需重新出方案并确认'); }
        if (plan.basis.codeVersion !== codeVersion(task)) { plan.state = 'stale'; throw new Error('代码版本发生变化，请重新核实方案并确认'); }
        if (plan.cancelRequested || this.now() >= Date.parse(plan.expiresAt)) { plan.state = 'stale'; throw new Error('确认已失效，请重新出方案并确认'); }
        const runbook = await this.knowledge.read({ sourceId: plan.basis.sourceId, documentId: plan.basis.documentId }, signal);
        if (!this.config.allowedSources?.includes(runbook.sourceId) || runbook.version !== plan.basis.version) { plan.state = 'stale'; throw new Error('文档已变化，旧确认失效'); }
        const current = await this.snapshot({ environment: plan.environment, service: plan.service, keys: plan.changes.map(c => c.key) }, signal);
        if (current.revision !== plan.revision || !plan.changes.every(c => equal(c.before, current.values[c.key]))) { plan.state = 'stale'; throw new Error('配置已变化，旧确认失效；没有覆盖新配置'); }
        signal?.throwIfAborted();
        plan.state = 'executing'; plan.attemptedAt = new Date(this.now()).toISOString(); plan.applyAttempts = (plan.applyAttempts ?? 0) + 1;
        await this.store.save();
        signal?.throwIfAborted();
        operation = await this.adapter.apply({ operationId: plan.id, environment: plan.environment, service: plan.service, expectedRevision: plan.revision, changes: structuredClone(plan.changes), publish: true }, signal);
      }
      if (operation?.state !== 'published' || operation.operationId !== plan.id || operation.environment !== plan.environment || operation.service !== plan.service || typeof operation.revision !== 'string' || !equal(operation.changes, plan.changes)) throw new Error('平台未确认对应的精确修改已发布，需要核实状态');
      plan.operation = operation;
      await this.store.save();
      const observed = await this.snapshot({ environment: plan.environment, service: plan.service, keys: plan.changes.map(c => c.key) }, signal);
      const probe = await this.adapter.verify({ operationId: plan.id, environment: plan.environment, service: plan.service, checks: plan.checks }, signal);
      const matched = observed.revision === operation.revision && observed.activeRevision === operation.revision && plan.changes.every(c => equal(c.after, observed.values[c.key]));
      if (!Array.isArray(probe?.checks) || !plan.checks.every(id => probe.checks.some(c => c.id === id && typeof c.passed === 'boolean'))) throw new Error('平台验证结果缺少确认方案中的检查项');
      plan.verificationResult = evidence(task, 'repair-verification', { planId: plan.id }, { operationId: plan.id, configurationMatches: matched, checks: probe.checks.map(c => ({ id: String(c.id), passed: c.passed, detail: redact(String(c.detail ?? '')).slice(0, 2000) })), effectiveRevision: probe.effectiveRevision ?? null, observedAt: new Date(this.now()).toISOString(), simulated: probe.simulated === true });
      plan.state = matched && probe.effectiveRevision === operation.revision && plan.checks.every(id => probe.checks.some(c => c.id === id && c.passed === true)) ? 'verified' : 'verification_failed';
      await this.store.save();
      return { planId: plan.id, state: plan.state, operation, verification: plan.verificationResult, recovery: plan.recovery, note: plan.state === 'verified' ? '仅通过所列检查；影响范围见检查内容。' : '验证未通过，已停止；未擅自回滚，按已记录修改前值重新提出恢复方案并确认。' };
    } catch (e) {
      if (!['stale', 'cancelled'].includes(plan.state)) plan.state = plan.attemptedAt ? 'needs_reconciliation' : 'stale';
      plan.error = redact(e.message); await this.store.save();
      return { planId: plan.id, state: plan.state, error: plan.error, note: '未能确认修复完成；保留执行意图和修改前值，不宣称已恢复。' };
    }
  }
}

export async function createRepairEngine({ root, config, store, knowledge }) {
  if (!config.repair?.enabled) return null;
  const settings = config.repair;
  const approvalMode = settings.approvalMode ?? 'harness';
  if (!['harness', 'chat'].includes(approvalMode) || approvalMode === 'chat' && (config.chat.ownerId === config.chat.botId || config.chat.deliveryMode === 'draft')) throw new Error('同账号或草稿模式必须在 Harness 内审批，不能通过群消息确认');
  if (!knowledge || !Array.isArray(settings.allowedSources) || !settings.allowedSources.length || !Array.isArray(settings.environments) || !settings.environments.length || settings.environments.some(e => /prod|production|正式|生产/i.test(e)) || typeof settings.adapterModule !== 'string') throw new Error('修复需知识源、明确的测试环境和部署适配器；不能包含生产环境');
  const adapter = await (await import(pathToFileURL(path.resolve(root, settings.adapterModule)))).createRepairAdapter(settings.options ?? {});
  if (!['read', 'apply', 'getOperation', 'verify'].every(k => typeof adapter?.[k] === 'function') || !['conditionalWrite', 'idempotency', 'publish'].every(k => adapter?.capabilities?.[k] === true)) throw new Error('部署写入适配器必须支持版本条件写入、持久幂等、发布和验证接口');
  const platformId = createHash('sha256').update(JSON.stringify({ module: settings.adapterModule, options: settings.options ?? {} })).digest('hex');
  return new RepairEngine({ adapter, store, knowledge, config: { ...settings, approvalMode, platformId, ownerId: config.chat.ownerId } });
}

export function formatRepairPlan(taskId, p, channel = 'chat') {
  const expires = new Date(p.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  const confirmation = channel === 'harness' ? '请在当前 Harness 会话的审批卡片审阅此差异，点击“允许一次”后执行；群内消息或聊天中的“同意”不授予权限。' : `仅开发本人引用本条回复：/确认修复 ${p.id}`;
  return `#${taskId} 待确认修复 ${p.id}\n环境：${p.environment}；服务：${p.service}；配置版本：${p.revision}\n\n精确修改\n${p.changes.map(c => `${c.key}\n  修改前：${JSON.stringify(c.before)}\n  修改后：${JSON.stringify(c.after)}`).join('\n')}\n\n依据：${p.reason}\n文档：${p.basis.sourceId}/${p.basis.location}，版本 ${p.basis.version} [${p.basis.runbookEvidenceId}]\n现场快照：[${p.basis.snapshotEvidenceId}]\n\n执行：修改以上配置并发布到 ${p.environment}/${p.service}。\n验证：${p.verification}（检查：${p.checks.join(', ')}）\n失败处理：停止继续修改，不自动回滚。恢复建议：${p.recovery}\n\n尚未修改。有效期至 ${expires}（北京时间）。${confirmation}\n不确认则不执行；文档或配置版本变化后需重新确认。`;
}

export function repairFooter(task) {
  const plans = Object.values(task?.repairPlans ?? {});
  if (!plans.some(p => p.attemptedAt)) return '本次未执行自动修复，未修改服务配置或业务数据。';
  const names = { verified: '修改发布后所列检查通过', verification_failed: '已发布但验证未通过', needs_reconciliation: '执行结果待核实', stale: '方案失效', cancelled: '方案取消', executing: '执行结果待核实' };
  return '自动修复记录\n' + plans.filter(p => p.attemptedAt).map(p => `- ${p.id} ${p.environment}/${p.service}：${names[p.state] ?? p.state}${p.verificationResult ? ` [${p.verificationResult.evidenceId}]` : ''}。未自动回滚。`).join('\n');
}
