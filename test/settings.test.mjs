import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import { Config, liveConfig, apply as applyRuntime } from '../src/runtime.mjs';
import { configureDesktop } from '../scripts/desktop-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Config 校验两项运行参数的范围并给出默认值', () => {
  const resolved = Config({});
  assert.equal(resolved.pollIntervalMs.get(), 10000);
  assert.deepEqual(resolved.chatGroupIds.get(), []);
  assert.equal(resolved.maxToolCalls, undefined);
  assert.equal(resolved.turnTimeoutMs, undefined);
  assert.equal(resolved.knowledgePath.get(), undefined);
  assert.equal(resolved.repositorySync.get(), true);
  assert.throws(() => Config({ pollIntervalMs: 100 }));
  assert.ok(Config({ pollIntervalMs: 600000, chatGroupIds: ['qa'] }));
});

test('liveConfig 优先读 volatile ref，缺失时回落到文件值', () => {
  const file = { mode: 'mock', chat: { groupIds: ['qa-test'], ownerId: 'me', botId: 'bot' }, pollIntervalMs: 2000, stateFile: '.local/tasks.json' };
  const refs = { pollIntervalMs: { get: () => 30000 } };
  const live = liveConfig(file, refs);
  assert.equal(live.pollIntervalMs, 30000);
  assert.deepEqual(live.chat.groupIds, ['qa-test']);
  assert.equal(live.mode, 'mock');
  refs.chatGroupIds = { get: () => ['qa-test', 'qa-staff'] };
  assert.deepEqual(live.chat.groupIds, ['qa-test', 'qa-staff']);
});

test('liveConfig 的知识源路径优先读 volatile ref，留空回落到文件值', () => {
  const file = { mode: 'mock', chat: { groupIds: ['qa'], ownerId: 'me', botId: 'bot' }, knowledge: { sources: [{ id: 'faq', title: 'FAQ', path: 'fixtures/knowledge' }] } };
  const refs = {};
  const live = liveConfig(file, refs);
  assert.equal(live.knowledge.sources[0].path, 'fixtures/knowledge');
  refs.knowledgePath = { get: () => 'config/company-knowledge.md' };
  assert.equal(live.knowledge.sources[0].path, 'config/company-knowledge.md');
  refs.knowledgePath = { get: () => '' };
  assert.equal(live.knowledge.sources[0].path, 'fixtures/knowledge');
});

test('liveConfig 的同步开关优先读 volatile ref，缺失时回落到文件值', () => {
  const file = { chat: {}, repositorySync: false };
  const refs = {};
  const live = liveConfig(file, refs);
  assert.equal(live.repositorySync, false);
  refs.repositorySync = { get: () => true };
  assert.equal(live.repositorySync, true);
});

test('运行中改 ref 后协调器按新间隔排程', async () => {
  const value = { poll: 5000 };
  const config = { pollIntervalMs: 5000, chat: { groupIds: ['qa'], ownerId: 'me', botId: 'bot' } };
  const live = liveConfig({ ...config, stateFile: '.local/tasks.json' }, { pollIntervalMs: { get: () => value.poll } });
  const scheduled = [];
  const chat = { poll: async () => ({ messages: [], nextCursor: '1' }) };
  const store = { data: { tasks: {}, seen: {}, outbox: [], cursor: null }, save: async () => {} };
  const { Coordinator } = await import('../src/coordinator.mjs');
  const c = new Coordinator({ store, chat, runner: { run: async () => {} }, config: live, log() {} });
  c.start((callback, delay) => { const entry = { callback, delay, cancelled: false }; scheduled.push(entry); return () => { entry.cancelled = true; }; });
  await c.cyclePending;
  assert.equal(scheduled.at(-1).delay, 5000);
  value.poll = 20000;
  scheduled.at(-1).callback();
  await c.cyclePending;
  assert.equal(scheduled.at(-1).delay, 20000);
  await c.stop();
});

test('开发安装把运行参数写进行配置', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'settings-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dshHome = path.join(dir, 'dsh'), profile = path.join(dshHome, 'profiles', 'desktop');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  await writeFile(path.join(profile, 'cordis.patch.yml'), '# empty\n');
  const config = { mode: 'mock', chat: { groupIds: ['qa-test'], ownerId: 'me', botId: 'bot' }, pollIntervalMs: 20000, stateFile: '.local/tasks.json', catalogFile: 'catalog.json' };
  await writeFile(path.join(dir, 'config.json'), JSON.stringify(config));
  const result = await configureDesktop({ root: dir, dshHome, configFile: 'config.json' });
  const text = await readFile(result.patchFile, 'utf8');
  const rows = text.split('\n').filter(line => line.startsWith('- {')).map(line => JSON.parse(line.slice(2)));
  const row = rows.find(entry => entry.insert)?.insert[0];
  assert.equal(row.config.pollIntervalMs, 20000);
  
  assert.deepEqual(row.config.chatGroupIds, ['qa-test']);
});

test('已有的 test-troubleshooting 覆盖行不会阻止开发安装写入', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'settings-override-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dshHome = path.join(dir, 'dsh'), profile = path.join(dshHome, 'profiles', 'desktop');
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  // Settings writes persist as a config override row, not an insert.
  await writeFile(path.join(profile, 'cordis.patch.yml'), '- id: test-troubleshooting\n  config:\n    pollIntervalMs: 20000\n');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ mode: 'mock', chat: { groupIds: ['qa'], ownerId: 'me', botId: 'bot' }, pollIntervalMs: 10000 }));
  const result = await configureDesktop({ root: dir, dshHome, configFile: 'config.json' });
  const text = await readFile(result.patchFile, 'utf8');
  assert.match(text, /id: test-troubleshooting/);
  assert.match(text, /BEGIN test-troubleshooting managed plugin/);
});

test('客户端只在设置栏目提供配置，不再声明插件页行配置', async () => {
  const source = await readFile(path.join(root, 'client.js'), 'utf8');
  assert.match(source, /__ModuleLoader__\.load\(/);
  assert.match(source, /id:\s*'dsh-troubleshooting'/);
  assert.match(source, /settings\.section/);
  assert.match(source, /configForms\.get\('test-troubleshooting'\)/);
  assert.match(source, /knowledgePath/);
  assert.match(source, /troubleshooting\/status/);
  assert.doesNotMatch(source, /plugins\.row\.config/);
  assert.doesNotMatch(source, /whileServed/);
  assert.doesNotMatch(source, /maxToolCalls/);
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.exports['./client'], './client.js');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.ok(manifest.files.includes('client.js'));
});

test('默认导出仍可在没有设置服务的宿主里启动', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'settings-boot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'catalog.json'), JSON.stringify({ environments: [], hosts: [], repositoryRoots: [] }));
  await mkdir(path.join(dir, '.agents', 'skills', 'test-environment-troubleshooting'), { recursive: true });
  await writeFile(path.join(dir, '.agents', 'skills', 'test-environment-troubleshooting', 'SKILL.md'), 'test');
  await writeFile(path.join(dir, 'chat.mjs'), 'export function createAdapter(){return {poll:async()=>({messages:[],nextCursor:"latest"})}}');
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({
    mode: 'mock', stateFile: '.local/state.json', catalogFile: 'catalog.json',
    chat: { groupIds: ['qa'], ownerId: 'me', botId: 'bot', adapterModule: 'chat.mjs' },
  }));
  let cleanup; const timers = [];
  const ctx = {
    get: () => ({ await: async () => {} }),
    on: () => () => {},
    effect: create => { cleanup = create(); },
    interval: () => () => {}, timeout: () => () => {},
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  applyRuntime(ctx, { root: dir, configFile: 'config.json' });
  const deadline = Date.now() + 1000;
  let runtime;
  do { try { runtime = JSON.parse(await readFile(path.join(dir, '.local/runtime.json'), 'utf8')); } catch {} if (!runtime?.ready) await new Promise(r => setTimeout(r, 10)); } while (!runtime?.ready && Date.now() < deadline);
  assert.equal(runtime?.ready, true);
  assert.equal(runtime.pollIntervalMs, 10000);
  assert.deepEqual(runtime.chatGroupIds, ['qa']);
  await cleanup();
});
