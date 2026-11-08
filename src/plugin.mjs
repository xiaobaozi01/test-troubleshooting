import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from './store.mjs';
import { HttpChatAdapter } from './chat.mjs';
import { QueryTools } from './queries.mjs';
import { HarnessRunner } from './harness-runner.mjs';
import { Coordinator } from './coordinator.mjs';
import { repairTaskTitles } from './titles.mjs';
import { browserInstructions } from './browser-support.mjs';
import { createKnowledgeBase } from './knowledge.mjs';

export const name = 'test-troubleshooting';
export const inject = ['agents', 'tools', 'systemPrompt', 'sessions', 'agentDefaultModel', 'attachments', 'sessionTitle', 'sessionPersistence', 'sessionQuery'];
export function apply(ctx, options = {}) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let coordinator, store, stopping = false, titleTimer, titleRepair;
  const runtimeFile = path.join(root, '.local/runtime.json');
  const status = async value => { await mkdir(path.dirname(runtimeFile), { recursive: true }); await writeFile(runtimeFile, JSON.stringify({ ...value, pid: process.pid, at: new Date().toISOString() }, null, 2), { mode: 0o600 }); };
  const boot = async () => {
    await ctx.get('loader')?.await();
    if (stopping) return;
    const config = JSON.parse(await readFile(path.resolve(root, options.configFile ?? 'config/demo.json'), 'utf8'));
    if (!['mock', 'ssh'].includes(config.mode)) throw new Error('mode 必须为 mock 或 ssh');
    if (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 500 || !Number.isInteger(config.turnTimeoutMs) || config.turnTimeoutMs < 1000 || !Number.isInteger(config.maxToolCalls) || config.maxToolCalls < 1) throw new Error('轮询、超时或工具预算配置无效');
    if (!config.chat?.groupIds?.length || !config.chat.ownerId || !config.chat.botId) throw new Error('需要群白名单、开发账号和助手账号');
    store = await new Store(path.resolve(root, config.stateFile)).load();
    await store.lock();
    const repaired = await repairTaskTitles(ctx, Object.values(store.data.tasks));
    await store.save();
    if (repaired) console.log(`[排障助手] 已补齐 ${repaired} 个排障会话标题`);
    titleTimer = setInterval(() => {
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
    const browser = config.deploymentBackend?.enabled ? await browserInstructions(options.browserSkillDirectory, config.deploymentBackend) : null;
    const knowledge = await createKnowledgeBase(root, config.knowledge);
    const runner = new HarnessRunner({ ctx, store, chat, queries, config, root, skill, browser, knowledge });
    coordinator = new Coordinator({ store, chat, runner, config, log: text => console.log(`[排障助手] ${text}`) });
    coordinator.start();
    await status({ ready: true, mode: config.mode, model: ctx.agentDefaultModel.currentSelection(), pollIntervalMs: config.pollIntervalMs, deploymentBackend: Boolean(browser), knowledgeSources: knowledge?.describe() ?? [] });
    console.log(`[排障助手] 已启动，${config.pollIntervalMs / 1000} 秒轮询一次，模式 ${config.mode}`);
  };
  void boot().catch(async e => { clearInterval(titleTimer); console.error(`[排障助手] 启动失败：${e.message}`); await status({ ready: false, error: e.message }); await store?.close(); });
  ctx.on('dispose', async () => { stopping = true; clearInterval(titleTimer); await titleRepair; await coordinator?.stop(); await store?.close(); await status({ ready: false, stopped: true }); });
}
