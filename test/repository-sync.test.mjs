import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { syncRepositories, updateRepository } from '../src/repository-sync.mjs';
import { QueryTools } from '../src/queries.mjs';
import { HarnessRunner } from '../src/harness-runner.mjs';
const exec = promisify(execFile);
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args])).stdout.trim();
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repo-sync-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git'), author = path.join(root, 'author'), checkout = path.join(root, 'checkouts', 'api');
  await mkdir(path.dirname(checkout), { recursive: true });
  await exec('git', ['init', '--bare', '--initial-branch=main', remote]);
  await exec('git', ['clone', remote, author]);
  for (const cwd of [author]) { await git(cwd, 'config', 'user.name', 'Sync Test'); await git(cwd, 'config', 'user.email', 'sync@example.invalid'); }
  await writeFile(path.join(author, 'Api.java'), 'class A { @GetMapping("/old") void get() {} }');
  await git(author, 'add', '.'); await git(author, 'commit', '-m', 'initial'); await git(author, 'push', '-u', 'origin', 'main');
  await exec('git', ['clone', remote, checkout]);
  await git(checkout, 'config', 'user.name', 'Sync Test'); await git(checkout, 'config', 'user.email', 'sync@example.invalid');
  return { root, remote, author, checkout };
}
async function pushChange(author) {
  await writeFile(path.join(author, 'Api.java'), 'class A { @GetMapping("/latest") void get() {} }');
  await git(author, 'add', '.'); await git(author, 'commit', '-m', 'new endpoint'); await git(author, 'push');
  return git(author, 'rev-parse', 'HEAD');
}

test('真实本地远端快进更新，并在同步后清除旧接口索引', async t => {
  const f = await fixture(t);
  const q = new QueryTools({ root: f.root, catalog: { environments: [], repositoryRoots: [path.dirname(f.checkout)] }, mode: 'ssh' });
  assert.equal((await q.findEndpoint({ endpoint: '/old' })).matches.length, 1);
  const commit = await pushChange(f.author);
  const result = await q.prepareForDiagnosis();
  assert.equal(result.ready, true); assert.equal(result.repositories[0].status, 'updated');
  assert.equal(result.repositories[0].commit, commit);
  assert.equal((await q.findEndpoint({ endpoint: '/latest' })).matches.length, 1);
  assert.equal((await q.findEndpoint({ endpoint: '/old' })).matches.length, 0);
  assert.equal((await q.prepareForDiagnosis()).repositories[0].status, 'up-to-date');
});
test('本地修改和未跟踪文件均保留，阻止自动更新', async t => {
  const f = await fixture(t); await pushChange(f.author);
  const before = await git(f.checkout, 'rev-parse', 'HEAD');
  await writeFile(path.join(f.checkout, 'Api.java'), 'my unfinished work');
  assert.equal((await updateRepository(f.checkout)).status, 'blocked');
  assert.equal(await readFile(path.join(f.checkout, 'Api.java'), 'utf8'), 'my unfinished work');
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), before);
  await git(f.checkout, 'checkout', '--', 'Api.java'); // Only reset the disposable test fixture.
  await writeFile(path.join(f.checkout, 'notes.txt'), 'local notes');
  assert.equal((await updateRepository(f.checkout)).status, 'blocked');
});
test('分支分叉时不 merge/rebase/reset，本地提交不丢失', async t => {
  const f = await fixture(t); await pushChange(f.author);
  await writeFile(path.join(f.checkout, 'local.txt'), 'local commit');
  await git(f.checkout, 'add', '.'); await git(f.checkout, 'commit', '-m', 'local work');
  const before = await git(f.checkout, 'rev-parse', 'HEAD');
  const result = await updateRepository(f.checkout);
  assert.equal(result.status, 'blocked'); assert.match(result.reason, /分叉/);
  assert.equal(await git(f.checkout, 'rev-parse', 'HEAD'), before);
});
test('detached HEAD、无远端跟踪分支、远端不可达均不能假报最新', async t => {
  const f = await fixture(t);
  await git(f.checkout, 'checkout', '--detach');
  assert.ok(['failed', 'blocked'].includes((await updateRepository(f.checkout)).status));
  await git(f.checkout, 'checkout', 'main');
  await git(f.checkout, 'branch', '--unset-upstream');
  assert.ok(['failed', 'blocked'].includes((await updateRepository(f.checkout)).status));
  await git(f.checkout, 'branch', '--set-upstream-to', 'origin/main');
  await git(f.checkout, 'remote', 'set-url', 'origin', path.join(f.root, 'missing.git'));
  const result = await updateRepository(f.checkout);
  assert.equal(result.status, 'failed'); assert.match(result.reason, /拉取远端/);
});
test('重复根目录和模块路径只同步一次；未发现 Git 仓库不声称成功', async t => {
  const f = await fixture(t); const module = path.join(f.checkout, 'module'); await mkdir(module);
  const result = await syncRepositories(f.root, { repositoryRoots: [f.checkout, module, f.checkout] }, 'ssh');
  assert.equal(result.ready, true); assert.equal(result.repositories.length, 1);
  const empty = path.join(f.root, 'empty'); await mkdir(empty);
  assert.equal((await syncRepositories(f.root, { repositoryRoots: [empty] }, 'ssh')).ready, false);
  assert.equal((await syncRepositories(f.root, {}, 'mock')).mode, 'mock');
});
test('同步失败时不创建Agent、不调用模型，保存同步证据', async () => {
  const task = { id: 'T-test', evidence: {} }; let created = false;
  const runner = new HarnessRunner({ queries: { prepareForDiagnosis: async () => ({ ready: false, repositories: [{ status: 'blocked' }] }) }, store: { save: async () => {} } });
  runner.getAgent = async () => { created = true; };
  await assert.rejects(runner.run(task, {}), /代码未能同步/);
  assert.equal(created, false); assert.equal(task.repositorySync.ready, false);
  assert.equal(Object.values(task.evidence)[0].kind, 'repository-sync');
});

test('设置关闭排障前同步时跳过仓库同步并保存跳过证据', async () => {
  const runner = new HarnessRunner({ config: { repositorySync: false }, queries: { prepareForDiagnosis: async () => { throw new Error('不应调用同步'); } }, store: { save: async () => {} } });
  const task = { id: 'T-skip', evidence: {}, status: 'paused' };
  assert.equal(await runner.run(task, {}), null);
  assert.equal(task.repositorySync.skipped, true);
  assert.equal(task.repositorySync.ready, true);
  assert.equal(Object.values(task.evidence)[0].kind, 'repository-sync');
});
