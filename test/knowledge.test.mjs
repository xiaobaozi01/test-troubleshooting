import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeBase } from '../src/knowledge.mjs';
import { HarnessRunner, validateReport } from '../src/harness-runner.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'troubleshoot-knowledge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'faq'));
  return { root, create: () => createKnowledgeBase(root, { sources: [{ id: 'faq', path: 'faq' }] }) };
}

test('中文与错误码检索，按正文行号引用；JSON 条目保留审核时间，内容脱敏', async t => {
  const { root, create } = await fixture(t);
  await writeFile(path.join(root, 'faq', 'cache.md'), '# 缓存命名空间\n适用：日志明确出现 CACHE_NAMESPACE is empty\npassword=sample-secret\n请核查配置，而非直接重启。');
  await writeFile(path.join(root, 'faq', 'accounts.json'), JSON.stringify({ documents: [{ id: 'locked', title: '账号锁定', tags: ['ACCOUNT_LOCKED'], updatedAt: '2026-11-09', content: '先核查锁定状态，再联系管理员。' }] }));
  const kb = await create();
  const found = await kb.search({ query: '测试缓存命名空间异常 CACHE_NAMESPACE' });
  const candidate = found.documents.find(d => d.title === '缓存命名空间');
  assert.ok(candidate); assert.ok(!JSON.stringify(found).includes('sample-secret'));
  const doc = await kb.read({ ...candidate, startLine: 2, limit: 2 });
  assert.equal(doc.lines[0].line, 2); assert.match(doc.lines[0].text, /CACHE_NAMESPACE/);
  assert.equal(doc.nextLine, 4); assert.equal(doc.version, candidate.version);
  const account = (await kb.search({ query: 'ACCOUNT_LOCKED' })).documents[0];
  assert.equal(account.updatedAt, '2026-11-09');
  assert.match((await kb.read(account)).lines[0].text, /管理员/);
});

test('本地资料更新立即可见；读取拒绝任意路径，资料消失不会返回陈旧正文', async t => {
  const { root, create } = await fixture(t);
  const file = path.join(root, 'faq', 'one.md');
  await writeFile(file, '# 账号\nACCOUNT_LOCKED：旧流程');
  const kb = await create(), candidate = (await kb.search({ query: 'ACCOUNT_LOCKED' })).documents[0];
  await writeFile(file, '# 账号\nACCOUNT_LOCKED：新流程');
  const updated = await kb.read(candidate);
  assert.match(updated.lines[1].text, /新流程/); assert.notEqual(updated.version, candidate.version);
  await assert.rejects(kb.read({ sourceId: 'faq', documentId: '../secret.txt' }), /不存在/);
  await rm(file);
  await assert.rejects(kb.read(candidate), /不存在/);
});

test('坏文件、不可用源和扫描上限显式返回警告；符号链接不能读入目录外资料', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'private.md'), '# 私有\nOUTSIDE_SECRET');
  await symlink(path.join(root, 'private.md'), path.join(root, 'faq', 'escape.md'));
  await writeFile(path.join(root, 'faq', 'bad.json'), '{');
  await writeFile(path.join(root, 'faq', 'huge.md'), 'X'.repeat(513 * 1024));
  await writeFile(path.join(root, 'faq', 'ok.md'), '# 连接\nUnknownHostException 请核查 DNS');
  const kb = await createKnowledgeBase(root, { sources: [{ id: 'missing', path: 'missing' }, { id: 'faq', path: 'faq' }] });
  const found = await kb.search({ query: 'UnknownHostException OUTSIDE_SECRET' });
  assert.equal(found.documents.length, 1); assert.equal(found.documents[0].title, '连接');
  assert.ok(found.warnings.some(w => w.includes('missing')));
  assert.ok(found.warnings.some(w => w.includes('bad.json')));
  assert.ok(found.warnings.some(w => w.includes('huge.md')));
  assert.equal(found.truncated, true);
});

test('支持模块化知识源并保留出处；模块失败时不冒充无匹配，取消信号继续传播', async t => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'source.mjs'), `export async function createSource(options) { return {
    async search({query,limit},signal) { signal?.throwIfAborted(); return {documents:[{id:'doc-42',title:options.title,excerpt:query+' '+limit,location:'https://wiki.example.invalid/42'}]}; },
    async read({documentId},signal) { signal?.throwIfAborted(); if(documentId!=='doc-42')throw new Error('unknown'); return {title:options.title,text:'适用条件\\n验证步骤',location:'https://wiki.example.invalid/42'}; }
  }; }`);
  const kb = await createKnowledgeBase(root, { sources: [{ id: 'wiki', type: 'module', module: 'source.mjs', options: { title: '公司知识' } }] });
  const candidate = (await kb.search({ query: '超时', limit: 2 })).documents[0];
  assert.equal(candidate.title, '公司知识'); assert.equal(candidate.excerpt, '超时 2');
  assert.equal((await kb.read(candidate)).location, 'https://wiki.example.invalid/42');
  await assert.rejects(kb.read({ ...candidate, documentId: 'unknown' }), /unknown/);
  const abort = new AbortController(); abort.abort(new Error('cancelled'));
  await assert.rejects(kb.search({ query: '超时' }, abort.signal), /cancelled/);
});

test('未配置时保持兼容；配置与查询参数严格验证', async t => {
  const { root, create } = await fixture(t);
  assert.equal(await createKnowledgeBase(root), null);
  await assert.rejects(createKnowledgeBase(root, { sources: {} }), /数组/);
  await assert.rejects(createKnowledgeBase(root, { sources: [{ id: 'same', path: '.' }, { id: 'same', path: '.' }] }), /唯一/);
  const kb = await create();
  await assert.rejects(kb.search({ query: '', limit: 100 }), /关键词/);
  await assert.rejects(kb.search({ query: 'DNS', sourceId: 'other' }), /未知/);
});

test('知识查询接入真实证据引用，无需固定调用日志工具', async t => {
  const { root, create } = await fixture(t);
  await writeFile(path.join(root, 'faq', 'answer.md'), '# FAQ\nONLY_DOC：参考操作说明，不宣称已修复。');
  const registered = new Map();
  const runner = new HarnessRunner({ root, knowledge: await create(), config: {}, store: { save: async () => {} }, skill: '' });
  const task = { id: 'T-knowledge', evidence: {}, calls: [], actions: {} };
  await runner.register({ tools: { restrict() {}, register: def => registered.set(def.name, def) }, systemPrompt: { section() {} } }, task);
  runner.turns.set(task.id, { message: { id: 'm-1' } });
  const exec = { signal: new AbortController().signal };
  const found = await registered.get('troubleshoot_knowledge_search').execute({ query: 'ONLY_DOC' }, exec);
  const doc = await registered.get('troubleshoot_knowledge_read').execute(found.documents[0], exec);
  assert.equal(task.evidence[doc.evidenceId].kind, 'knowledge-document');
  const report = { summary: '资料处理方法', findings: [{ statement: '文档给出的步骤', evidenceIds: [doc.evidenceId] }], hypotheses: [], nextSteps: ['核实适用条件'], limitations: ['尚未验证运行状态'] };
  validateReport(task, report);
  assert.equal((await registered.get('troubleshoot_finish').execute(report, exec)).accepted, true);
  assert.deepEqual(task.calls.map(c => c.tool), ['troubleshoot_knowledge_search', 'troubleshoot_knowledge_read', 'troubleshoot_finish']);
});

