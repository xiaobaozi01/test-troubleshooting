import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { Store } from './store.mjs';
import { HttpChatAdapter } from './chat.mjs';
import { QueryTools } from './queries.mjs';
import { HarnessRunner } from './harness-runner.mjs';
import { Coordinator } from './coordinator.mjs';
import { repairTaskTitles } from './titles.mjs';
import { browserInstructions } from './browser-support.mjs';
import { createKnowledgeBase } from './knowledge.mjs';

// A bundle row cannot know where the profile keeps BrowserSkill; resolve the package
// installed in the running profile instead of copying its path into the manifest.
function profileDirectory(ctx) {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR;
  const base = ctx?.baseUrl;
  if (typeof base === 'string') return base.startsWith('file:') ? fileURLToPath(base) : base;
  if (base instanceof URL) return fileURLToPath(base);
  return undefined;
}

function installedBrowserSkillDirectory(ctx) {
  const directory = profileDirectory(ctx);
  if (!directory) return undefined;
  try {
    const entry = createRequire(path.join(directory, 'package.json')).resolve('@wxg-prc-cpg/browser-skill-dsh-plugin');
    return path.resolve(path.dirname(entry), '..');
  } catch {
    return undefined;
  }
}

function browserSkillDirectory(options, ctx) {
  const directory = options.browserSkillDirectory ?? installedBrowserSkillDirectory(ctx);
  if (!directory) throw new Error('没有找到 BrowserSkill 插件；请在该 profile 安装并启用 BrowserSkill。');
  return directory;
}

// Volatile values are edited in the plugin's settings page: the write lands in the
// profile override layer and the Loader updates these refs in place, so the runtime
// reads them when it needs them instead of caching them at boot.
function readOption(options, field, fallback) {
  const raw = options?.[field];
  if (raw !== null && typeof raw === 'object' && typeof raw.get === 'function') return raw.get();
  return raw ?? fallback;
}

// The file stays the source of mode, accounts, adapters and paths; the three
// tunables are overridden by their config refs and fall back to the file.
export function liveConfig(file, options) {
  const config = { ...file, chat: { ...file.chat } };
  if (file.knowledge) {
    const sources = (file.knowledge.sources ?? []).map(source => ({ ...source }));
    config.knowledge = { ...file.knowledge, sources };
    const index = sources.findIndex(source => (source.type ?? 'local') === 'local');
    if (index !== -1) {
      const source = sources[index];
      const fallback = source.path;
      Object.defineProperty(source, 'path', {
        enumerable: true, configurable: true,
        get: () => readOption(options, 'knowledgePath', fallback) || fallback,
      });
    }
  }
  Object.defineProperties(config.chat, {
    groupIds: { enumerable: true, configurable: true, get: () => readOption(options, 'chatGroupIds', file.chat?.groupIds) },
  });
  Object.defineProperties(config, {
    pollIntervalMs: { enumerable: true, configurable: true, get: () => readOption(options, 'pollIntervalMs', file.pollIntervalMs ?? 10000) },
    repositorySync: { enumerable: true, configurable: true, get: () => readOption(options, 'repositorySync', file.repositorySync ?? true) },
  });
  return config;
}

export const name = 'test-troubleshooting';
export const inject = ['timer', 'agents', 'tools', 'systemPrompt', 'sessions', 'agentDefaultModel', 'attachments', 'sessionTitle', 'sessionPersistence', 'sessionQuery'];
export const Config = z.object({
  root: z.string(),
  configFile: z.string(),
  hostMode: z.string(),
  runtimeFile: z.string(),
  browserSkillDirectory: z.string(),
  chatAdapterModule: z.string(),
  pollIntervalMs: z.number().step(1).min(500).max(600000).default(10000).volatile(),
  chatGroupIds: z.array(z.string()).volatile(),
  knowledgePath: z.string().volatile(),
  repositorySync: z.boolean().default(true).volatile(),
});
export function apply(ctx, options = {}) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let coordinator, store, stopping = false, cancelTitleTimer, titleRepair, ownsState = false, live, lastStatus;
  let stopBoot;
  const stopped = new Promise(resolve => { stopBoot = resolve; });
  const runtimeFile = path.resolve(root, options.runtimeFile ?? '.local/runtime.json');
  const status = async value => { lastStatus = value; await mkdir(path.dirname(runtimeFile), { recursive: true }); await writeFile(runtimeFile, JSON.stringify({ ...value, pid: process.pid, at: new Date().toISOString() }, null, 2), { mode: 0o600 }); };
  const boot = async () => {
    await Promise.race([ctx.get('loader')?.await(), stopped]);
    if (stopping) return;
    const file = JSON.parse(await readFile(path.resolve(root, options.configFile ?? 'config/demo.json'), 'utf8'));
    const config = live = liveConfig(file, options);
    if (!['mock', 'ssh'].includes(config.mode)) throw new Error('mode 必须为 mock 或 ssh');
    const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
    if (!integer(config.pollIntervalMs, 500, 600000)) throw new Error('轮询间隔配置无效');
    if (!config.chat?.groupIds?.length || !config.chat.ownerId || !config.chat.botId) throw new Error('需要群白名单、开发账号和助手账号');
    store = await new Store(path.resolve(root, config.stateFile)).load();
    await store.lock();
    ownsState = true;
    if (stopping) return;
    const repaired = await repairTaskTitles(ctx, Object.values(store.data.tasks));
    await store.save();
    if (repaired) console.log(`[排障助手] 已补齐 ${repaired} 个排障会话标题`);
    if (stopping) return;
    cancelTitleTimer = ctx.interval(() => {
      if (stopping || titleRepair) return;
      const pending = Object.values(store.data.tasks).filter(t => t.started && !t.titleKnown);
      if (!pending.length) return;
      titleRepair = repairTaskTitles(ctx, pending).then(() => store.save()).catch(e => console.error(`[排障助手] 标题维护失败：${e.message}`)).finally(() => { titleRepair = null; });
    }, 60000);
    const adapterModule = options.chatAdapterModule ?? config.chat.adapterModule;
    const chat = adapterModule
      ? await (await import(pathToFileURL(path.resolve(root, adapterModule)))).createAdapter(config.chat)
      : new HttpChatAdapter(config.chat);
    const catalog = JSON.parse(await readFile(path.resolve(root, config.catalogFile), 'utf8'));
    const queries = new QueryTools({ root, catalog, mode: config.mode });
    const skill = await readFile(path.join(root, '.agents/skills/test-environment-troubleshooting/SKILL.md'), 'utf8');
    const knowledge = await createKnowledgeBase(root, config.knowledge);
    let browser = null, browserError = null;
    try {
      if (!config.deploymentBackend) config.deploymentBackend = {};
      browser = await browserInstructions(browserSkillDirectory(options, ctx), config.deploymentBackend);
    } catch (e) {
      browserError = e.message;
      console.warn(`[排障助手] 未启用部署后台浏览能力：${e.message}`);
    }
    const runner = new HarnessRunner({ ctx, store, chat, queries, config, root, skill, browser, knowledge });
    coordinator = new Coordinator({ store, chat, runner, config, log: text => console.log(`[排障助手] ${text}`) });
    if (stopping) return;
    coordinator.start((callback, delay) => ctx.timeout(callback, delay));
    const localKnowledgePath = config.knowledge?.sources?.find(source => (source.type ?? 'local') === 'local')?.path;
    await status({ ready: true, mode: config.mode, hostMode: options.hostMode ?? 'embedded', scheduler: 'harness-timer', stateFile: path.resolve(root, config.stateFile), deliveryMode: 'auto', repositorySync: config.repositorySync, model: ctx.agentDefaultModel.currentSelection(), pollIntervalMs: config.pollIntervalMs, chatGroupIds: [...config.chat.groupIds], deploymentBackend: Boolean(browser), browserError, knowledgeSources: knowledge?.describe() ?? [], knowledgePath: localKnowledgePath ? path.resolve(root, localKnowledgePath) : null });
    console.log(`[排障助手] 已启动，${config.pollIntervalMs / 1000} 秒轮询一次，模式 ${config.mode}`);
  };
  const booting = boot().catch(async e => {
    cancelTitleTimer?.(); console.error(`[排障助手] 启动失败：${e.message}`);
    await coordinator?.stop(); await titleRepair; await store?.close();
    if (ownsState) await status({ ready: false, error: e.message });
  });
  // The settings page writes volatile fields; report the accepted values without
  // rebuilding the polling loop, which reads them on its next cycle.
  if (typeof ctx.on === 'function') ctx.effect(() => ctx.on('loader/volatile-update', () => {
    if (!live || !lastStatus?.ready) return;
    void status({ ...lastStatus, pollIntervalMs: live.pollIntervalMs, chatGroupIds: [...live.chat.groupIds], repositorySync: live.repositorySync, knowledgePath: (() => { const local = live.knowledge?.sources?.find(source => (source.type ?? 'local') === 'local')?.path; return local ? path.resolve(root, local) : null; })() }).catch(e => console.error(`[排障助手] 状态刷新失败：${e.message}`));
  }), 'test-troubleshooting volatile status');
  const webServer = ctx.get('webServer');
  if (typeof webServer?.register === 'function') ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/troubleshooting/status',
    resource: async () => new Response(JSON.stringify({
      ready: lastStatus?.ready === true,
      deploymentBackend: lastStatus?.deploymentBackend === true,
      browserError: lastStatus?.browserError ?? null,
      knowledgePath: lastStatus?.knowledgePath ?? null,
    }), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }),
  }), 'test-troubleshooting status route');
  ctx.effect(() => {
    let cleanup;
    return () => cleanup ??= (async () => {
      stopping = true; stopBoot(); cancelTitleTimer?.(); await booting; cancelTitleTimer?.();
      try { await titleRepair; await coordinator?.stop(); }
      finally { await store?.close(); if (ownsState) await status({ ready: false, stopped: true }); }
    })();
  }, 'test-troubleshooting lifecycle');
}
