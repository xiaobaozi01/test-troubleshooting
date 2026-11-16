import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { configureDesktop, updateDesktopPatch } from '../scripts/desktop-profile.mjs';
import { Coordinator } from '../src/coordinator.mjs';
import { HarnessRunner } from '../src/harness-runner.mjs';
import { apply as applyRuntime } from '../src/runtime.mjs';

const pause = () => new Promise(resolve => setImmediate(resolve));
const config = { pollIntervalMs: 10000, chat: { groupIds: ['qa'], ownerId: 'me', botId: 'bot' } };
function setup(chat, runner = { run: async () => { throw new Error('空群不应调用 Agent'); } }) {
  const scheduled = [];
  const schedule = (callback, delay) => { const entry = { callback, delay, cancelled: false }; scheduled.push(entry); return () => { entry.cancelled = true; }; };
  const store = { data: { tasks: {}, seen: {}, outbox: [], cursor: null }, save: async () => {} };
  const coordinator = new Coordinator({ store, chat, runner, config, log() {} });
  return { store, coordinator, scheduled, schedule };
}
const settle = async c => { await c.cyclePending; await c.workPending; await c.sendPending; };

test('空群只调用群接口，使用宿主定时器且启动幂等；停用取消后续回调', async () => {
  let polls = 0, runs = 0;
  const { coordinator: c, scheduled, schedule } = setup({ poll: async () => { polls++; return { messages: [], nextCursor: String(polls) }; } }, { run: async () => { runs++; } });
  c.start(schedule); c.start(schedule); await settle(c);
  assert.equal(polls, 1); assert.equal(runs, 0); assert.equal(scheduled.length, 1); assert.equal(scheduled[0].delay, 10000);
  scheduled[0].callback(); await settle(c);
  assert.equal(polls, 2); assert.equal(runs, 0);
  await c.stop(); assert.equal(scheduled.at(-1).cancelled, true);
  scheduled.at(-1).callback(); await settle(c);
  assert.equal(polls, 2);
});

test('宿主轮询失败退避，成功恢复原周期；不重叠执行排障', async () => {
  let polls = 0, runs = 0, release;
  const runner = { run: () => { runs++; return new Promise(resolve => { release = resolve; }); }, dispose: async () => release?.({ kind: 'ask', question: '已停用不应发送' }) };
  const { coordinator: c, scheduled, schedule, store } = setup({ poll: async () => {
    if (++polls === 1) throw new Error('offline');
    return { messages: polls === 2 ? [{ id: 'm-1', groupId: 'qa', senderId: 'tester', text: '报错', mentions: ['me'] }] : [], nextCursor: String(polls) };
  } }, runner);
  c.start(schedule); await c.cyclePending;
  assert.equal(scheduled.at(-1).delay, 20000);
  scheduled.at(-1).callback(); await c.cyclePending; await pause();
  assert.equal(scheduled.at(-1).delay, 10000); assert.equal(runs, 1);
  scheduled.at(-1).callback(); await c.cyclePending;
  assert.equal(runs, 1);
  await c.stop();
  assert.equal(store.data.outbox.length, 0); assert.equal(Object.values(store.data.tasks)[0].messages[0].handled, false);
});

test('停用会中断正在等待的群请求，不重新排定轮询', async () => {
  let receivedSignal;
  const { coordinator: c, scheduled, schedule } = setup({ poll: (_cursor, signal) => new Promise((_resolve, reject) => { receivedSignal = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
  c.start(schedule); await pause(); await c.stop();
  assert.equal(receivedSignal.aborted, true); assert.equal(scheduled.length, 0); assert.equal(c.failures, 0);
});

test('桌面安装只维护自己的配置块，可重复执行、备份、移除；不改模型或 profile 包清单', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = path.join(root, 'dsh'), directory = path.join(dshHome, 'profiles', 'desktop');
  await mkdir(directory, { recursive: true });
  const pkg = JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } });
  const original = '# custom settings\n- id: agent-default-model\n  config:\n    provider: internal\n    model: company-model\n';
  await writeFile(path.join(directory, 'package.json'), pkg);
  await writeFile(path.join(directory, 'cordis.patch.yml'), original);
  await writeFile(path.join(root, 'company.json'), JSON.stringify({ mode: 'ssh' }));
  const input = { root, dshHome, configFile: 'company.json' };
  const dry = await configureDesktop({ ...input, dryRun: true });
  assert.equal(dry.changed, true); assert.equal(await readFile(dry.patchFile, 'utf8'), original);
  const installed = await configureDesktop(input);
  assert.equal(await readFile(installed.backup, 'utf8'), original);
  const modified = await readFile(installed.patchFile, 'utf8');
  assert.ok(modified.startsWith(original)); assert.match(modified, /"hostMode":"desktop"/); assert.ok(!modified.includes('schedule_create'));
  assert.equal((await configureDesktop(input)).changed, false);
  assert.equal(await readFile(path.join(directory, 'package.json'), 'utf8'), pkg);
  await configureDesktop({ ...input, remove: true });
  assert.equal(await readFile(installed.patchFile, 'utf8'), original);
});

test('不覆盖未知的排障插件配置或损坏的管理块，空 YAML 列表可安全添加', () => {
  assert.throws(() => updateDesktopPatch('- insert:\n    - id: test-troubleshooting\n', [{ insert: [] }]), /已有/);
  assert.throws(() => updateDesktopPatch('# BEGIN test-troubleshooting managed plugin\n', []), /标记/);
  assert.ok(!updateDesktopPatch('# comment\n[]\n', [{ insert: [] }]).includes('[]\n# BEGIN'));
});

test('桌面 BrowserSkill 复用现有 bundle，只追加配置；没有 CLI 覆盖时保留原路径', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-browser-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = path.join(root, 'dsh'), directory = path.join(dshHome, 'profiles', 'desktop');
  const browserDirectory = path.join(directory, 'node_modules', '@wxg-prc-cpg', 'browser-skill-dsh-plugin');
  await mkdir(path.join(browserDirectory, 'lib'), { recursive: true });
  await writeFile(path.join(browserDirectory, 'package.json'), JSON.stringify({ main: 'lib/index.mjs' }));
  await writeFile(path.join(browserDirectory, 'lib', 'index.mjs'), 'export const name = "browser-skill";');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@wxg-prc-cpg/browser-skill-dsh-plugin'] } } }));
  const original = '- id: browserskill\n  config:\n    bskPath: /native/bsk\n    maxSessions: 5\n';
  await writeFile(path.join(directory, 'cordis.patch.yml'), original);
  await writeFile(path.join(root, 'demo.json'), JSON.stringify({ mode: 'mock' }));
  const savedEnv = process.env.BSK_PATH;
  delete process.env.BSK_PATH;
  t.after(() => { if (savedEnv === undefined) delete process.env.BSK_PATH; else process.env.BSK_PATH = savedEnv; });
  const result = await configureDesktop({ root, dshHome, configFile: 'demo.json' });
  const text = await readFile(result.patchFile, 'utf8');
  const entries = text.split('\n').filter(l => l.startsWith('- {')).map(l => JSON.parse(l.slice(2)));
  assert.ok(text.startsWith(original));
  assert.deepEqual(entries[0], { id: 'browserskill', config: { lazyTools: false } });
  assert.equal(entries[1].insert.length, 1); assert.equal(entries[1].insert[0].id, 'test-troubleshooting');
  assert.equal(entries[1].insert[0].config.browserSkillDirectory, await realpath(browserDirectory));
});

test('停用期间才完成创建的 Agent 会被释放，不在插件停用后开始排障', async () => {
  let complete, disposed = false;
  const runner = new HarnessRunner({ ctx: { agents: { get() {}, create: () => new Promise(resolve => { complete = resolve; }) }, agentDefaultModel: { currentSelection: () => ({ provider: 'company', model: 'internal' }) } }, root: '.', store: { save: async () => {} } });
  const pending = runner.getAgent({ id: 'T-race', sessionId: 'owned' });
  await runner.dispose();
  complete({ agent: {}, dispose: async () => { disposed = true; } });
  await assert.rejects(pending, /已停用/); assert.equal(disposed, true); assert.equal(runner.handles.size, 0);
});

test('插件停用解除启动等待，不依赖不存在的 dispose 事件', async () => {
  let cleanup;
  const ctx = { get: () => ({ await: () => new Promise(() => {}) }), effect: create => { cleanup = create(); } };
  applyRuntime(ctx);
  assert.equal(typeof cleanup, 'function');
  await cleanup();
});

test('插件资源清理等待队列退出、释放状态锁，同一宿主可以重新加载', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'host-lifecycle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'catalog.json'), JSON.stringify({ environments: [], hosts: [], repositoryRoots: [] }));
  await writeFile(path.join(root, 'chat.mjs'), 'export function createAdapter(){return {poll:async()=>({messages:[],nextCursor:"latest"})}}');
  await mkdir(path.join(root, '.agents', 'skills', 'test-environment-troubleshooting'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'skills', 'test-environment-troubleshooting', 'SKILL.md'), 'test workflow');
  await writeFile(path.join(root, 'config.json'), JSON.stringify({ ...config, chat: { ...config.chat, adapterModule: 'chat.mjs' }, mode: 'mock', stateFile: '.local/state.json', catalogFile: 'catalog.json' }));
  for (let iteration = 0; iteration < 2; iteration++) {
    let cleanup; const timers = [];
    const timer = () => { const t = { cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
    const ctx = { get: () => ({ await: async () => {} }), effect: create => { cleanup = create(); }, interval: timer, timeout: timer, agentDefaultModel: { currentSelection: () => ({ provider: 'company', model: 'internal' }) } };
    applyRuntime(ctx, { root, configFile: 'config.json', hostMode: 'desktop' });
    const deadline = Date.now() + 1000;
    let runtime;
    do { try { runtime = JSON.parse(await readFile(path.join(root, '.local/runtime.json'), 'utf8')); } catch {} if (!runtime?.ready) await pause(); } while (!runtime?.ready && Date.now() < deadline);
    assert.equal(runtime?.ready, true); assert.equal(runtime.hostMode, 'desktop');
    await cleanup();
    assert.ok(timers.every(t => t.cancelled));
    await assert.rejects(readFile(path.join(root, '.local/state.json.lock')), { code: 'ENOENT' });
    assert.equal(JSON.parse(await readFile(path.join(root, '.local/runtime.json'), 'utf8')).stopped, true);
  }
});

test('bundle 安装后只补 BrowserSkill 覆盖，不再重复插入排障行', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'desktop-browser-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dshHome = path.join(root, 'dsh'), directory = path.join(dshHome, 'profiles', 'desktop');
  const browserDirectory = path.join(directory, 'node_modules', '@wxg-prc-cpg', 'browser-skill-dsh-plugin');
  await mkdir(path.join(browserDirectory, 'lib'), { recursive: true });
  await writeFile(path.join(browserDirectory, 'package.json'), JSON.stringify({ main: 'lib/index.mjs' }));
  await writeFile(path.join(browserDirectory, 'lib', 'index.mjs'), 'export const name = "browser-skill";');
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@wxg-prc-cpg/browser-skill-dsh-plugin'] } } }));
  const original = '- id: browserskill\n  config:\n    bskPath: /native/bsk\n';
  await writeFile(path.join(directory, 'cordis.patch.yml'), original);
  await writeFile(path.join(root, 'demo.json'), JSON.stringify({ mode: 'mock' }));
  const savedEnv = process.env.BSK_PATH;
  delete process.env.BSK_PATH;
  t.after(() => { if (savedEnv === undefined) delete process.env.BSK_PATH; else process.env.BSK_PATH = savedEnv; });
  const result = await configureDesktop({ root, dshHome, configFile: 'demo.json', browserOnly: true });
  const text = await readFile(result.patchFile, 'utf8');
  const entries = text.split('\n').filter(l => l.startsWith('- {')).map(l => JSON.parse(l.slice(2)));
  assert.deepEqual(entries, [{ id: 'browserskill', config: { lazyTools: false } }]);
});
