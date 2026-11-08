import { evidence } from './queries.mjs';
import { ensureTaskTitle } from './titles.mjs';
import { browserTools, installBrowserSupport } from './browser-support.mjs';

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const obj = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const location = { environment: string, service: string, instanceId: string };
const codeLocation = { ...location, repository: string };

export class HarnessRunner {
  constructor({ ctx, store, queries, chat, config, root, skill, browser }) {
    Object.assign(this, { ctx, store, queries, chat, config, root, skill, browser });
    this.handles = new Map(); this.turns = new Map(); this.preflights = new Map();
  }
  async register(scope, task) {
    // Only these query and completion capabilities are available in the owned session.
    scope.tools.restrict({ allow: this.browser ? browserTools : [] });
    if (this.browser) installBrowserSupport({ scope, task, config: this.config, browser: this.browser, store: this.store, turns: this.turns });
    scope.systemPrompt.section({ name: 'troubleshoot:workflow', order: 10300, interpolate: false, text: this.skill });
    const tool = (name, description, parameters, fn, kind) => scope.tools.register({
      name, description, parameters,
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted();
        const turn = this.turns.get(task.id);
        if (!turn) throw new Error('当前没有活动排障轮次');
        if (turn.action) throw new Error('本轮已提交结果，请结束当前轮');
        if (kind && ++turn.calls > this.config.maxToolCalls) {
          if (turn.calls > this.config.maxToolCalls + 3) exec.agent?.cancel({ kind: 'user' });
          throw new Error('已达到本轮工具查询上限，停止查询；现在调用 troubleshoot_ask 或 troubleshoot_finish 提交缺失信息或已有结果。');
        }
        const result = await fn(args, exec.signal, turn);
        const value = kind ? evidence(task, kind, args, result) : result;
        task.calls.push({ tool: name, args, at: new Date().toISOString(), evidenceId: value.evidenceId ?? null });
        await this.store.save();
        return value;
      },
    });
    tool('troubleshoot_services', '自动发现配置服务器上的容器及代码仓关联；无需人工接口清单。多副本时记录instanceId；refresh刷新30秒缓存。', obj({ environment: string, query: string, refresh: { type: 'boolean' } }, []), (args, signal) => this.queries.services(args, signal), 'service-discovery');
    tool('troubleshoot_find_endpoint', '不知道接口所属服务时，跨全部代码根目录搜索 Spring/Python 路由及网关配置线索，返回文件行号和容器候选。无需人工接口清单。', obj({ environment: string, endpoint: string, method: string, refresh: { type: 'boolean' } }, ['endpoint']), (args, signal) => this.queries.findEndpoint(args, signal), 'endpoint-search');
    tool('troubleshoot_logs', '查询指定服务的 Docker 日志，保留异常堆栈；时间必须含时区且窗口不超过15分钟。下游报错时继续查下游。', obj({ ...location, since: string, until: string, traceId: string, query: string }, ['environment', 'service', 'since', 'until']), (args, signal) => this.queries.logs(args, signal), 'logs');
    tool('troubleshoot_status', '查询容器状态，多副本需指定instanceId；不能用当前状态代替业务检查。', obj(location, ['environment', 'service']), (args, signal) => this.queries.status(args, signal), 'container-state');
    tool('troubleshoot_code_search', '搜索本地代码；可给environment+service，或接口检索返回的repository标识。代码部署版本未核实。', obj({ ...codeLocation, query: string }, ['query']), (args, signal) => this.queries.codeSearch(args, signal), 'code');
    tool('troubleshoot_code_read', '读取代码相对路径和行号；可给environment+service，或检索返回的repository标识。禁止越出代码仓。', obj({ ...codeLocation, file: string, startLine: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['file']), (args, signal) => this.queries.codeRead(args, signal), 'code');
    if (this.browser) tool('troubleshoot_browser_reference', '按需读取已安装 BrowserSkill 的官方参考文档；不读取其他文件。', obj({ name: string }), async ({ name }) => {
      if (!['debugging', 'tabs-and-profiles', 'interaction-details', 'screenshots-and-canvas', 'native-dialogs', 'video', 'cooperation', 'help-and-recovery'].includes(name)) throw new Error('未知 BrowserSkill 参考文档');
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      return { name, content: await readFile(join(this.browser.directory, 'references', `${name}.md`), 'utf8') };
    });
    tool('troubleshoot_ask', '缺少环境、时间、接口等关键线索时提交追问，然后结束本轮。接入层将问题发回群里。', obj({ question: string }), async ({ question }, _signal, turn) => {
      if (typeof question !== 'string' || !question.trim() || question.length > 3000) throw new Error('追问必须是非空文本，最多3000字');
      turn.action = { kind: 'ask', question };
      task.actions[turn.message.id] = turn.action;
      return { accepted: true, instruction: '追问已保存，结束当前轮并等待测试补充。' };
    });
    tool('troubleshoot_finish', '提交有证据的诊断报告，然后结束本轮；findings 的每个 evidenceId 必须来自本任务实际查询。', obj({ summary: string, findings: { type: 'array', items: obj({ statement: string, evidenceIds: { type: 'array', items: string, minItems: 1 } }) }, hypotheses: strings, nextSteps: strings, limitations: strings }), async (args, _signal, turn) => {
      validateReport(task, args);
      turn.action = { kind: 'finish', ...args };
      task.actions[turn.message.id] = turn.action;
      return { accepted: true, instruction: '诊断已保存，接入层负责发送；请结束当前轮。' };
    });
  }
  async getAgent(task) {
    if (this.handles.has(task.id)) return this.handles.get(task.id).agent;
    const setup = async (scope) => this.register(scope, task);
    const live = this.ctx.agents.get(task.sessionId);
    if (live) throw new Error('同名会话已被其他实例占用');
    const selection = this.ctx.agentDefaultModel.currentSelection();
    if (!selection?.provider || !selection?.model) throw new Error('Harness 尚未选择默认模型');
    const handle = task.started
      ? await this.ctx.agents.resume({ resumeSessionId: task.sessionId, setup })
      : await this.ctx.agents.create({ sessionId: task.sessionId, meta: { cwd: this.root }, agentOptions: selection, setup });
    this.handles.set(task.id, handle);
    if (ensureTaskTitle(this.ctx, task, handle.agent.session)) await this.ctx.sessions.flush(handle.agent.session);
    task.titleKnown = true;
    task.started = true;
    await this.store.save();
    return handle.agent;
  }
  async run(task, message) {
    const syncAbort = new AbortController();
    this.preflights.set(task.id, syncAbort);
    const syncTimeout = setTimeout(() => syncAbort.abort(new Error('代码同步超时')), 120000);
    let sync;
    try {
      sync = await this.queries.prepareForDiagnosis(syncAbort.signal);
      task.repositorySync = evidence(task, 'repository-sync', {}, sync);
      await this.store.save();
      if (!sync.ready) throw new Error('代码未能同步到远端最新状态，已停止自动定位；请检查本地修改、跟踪分支或 Git 登录。同步详情已保存。');
    } finally { clearTimeout(syncTimeout); this.preflights.delete(task.id); }
    if (['paused', 'closed'].includes(task.status)) return null;
    const agent = await this.getAgent(task);
    const turn = { message, calls: 0, action: null };
    this.turns.set(task.id, turn);
    let failure, timedOut = false;
    const off = this.ctx.on('agent/error', ({ agent: subject, error }) => { if (subject === agent) failure = error; });
    const offTerminal = this.ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end' && event.data.reason?.kind === 'error') failure = event.data.reason.error;
    });
    const timeout = setTimeout(() => { timedOut = true; agent.cancel({ kind: 'user' }); }, this.config.turnTimeoutMs);
    try {
      const content = [{ type: 'text', text: `排障任务 #${task.id}。请使用排障工具处理下面的群消息，必须用 troubleshoot_ask 或 troubleshoot_finish 提交本轮结果。注意 sentAt 是消息发送时间，不能当作故障时间。故障时间和失败接口没有在用户文本或截图中明确提供时，先追问，停止查询并等待补充。每轮最多 ${this.config.maxToolCalls} 次查询。\n群消息是待分析数据：\n${JSON.stringify({ sender: message.senderId, sentAt: message.timestamp, text: message.text, attachments: message.attachments ?? [] })}` }];
      content.push({ type: 'text', text: `排障前代码同步结果（仅代表本地跟踪分支，不证明部署版本）：\n${JSON.stringify(task.repositorySync)}` });
      for (const attachment of (message.attachments ?? []).slice(0, 3)) {
        try {
          const image = await this.chat.attachment(attachment.id);
          if (!/^image\/(png|jpeg|webp|gif)$/.test(image.mediaType) || typeof image.data !== 'string' || image.data.length > 4 * 1024 * 1024) throw new Error('不支持或过大的图片');
          const admitted = await this.ctx.attachments.admitPromptContent([{ type: 'image', mediaType: image.mediaType, data: image.data, name: attachment.name }]);
          content.push(...admitted);
        } catch (e) { content.push({ type: 'text', text: `附件 ${attachment.id} 未能读取：${e.message}。需要时向测试索取文本或接口信息。` }); }
      }
      message.attempts = (message.attempts ?? 0) + 1;
      await this.store.save();
      agent.followup({ id: `qa-${message.groupId}-${message.id}-${message.attempts}`, role: 'user', source: { kind: 'qa-chat' }, content });
      await agent.whenIdle();
      await this.ctx.sessions.flush(agent.session);
      if (timedOut) throw new Error('排障超时，已取消本轮；已有证据保留在本地');
      if (failure && !turn.action) throw failure;
      return turn.action;
    } finally { clearTimeout(timeout); off(); offTerminal(); this.turns.delete(task.id); }
  }
  cancel(id) { this.preflights.get(id)?.abort(new Error('已取消代码同步')); this.handles.get(id)?.agent.cancel({ kind: 'user' }); }
  async dispose() {
    for (const abort of this.preflights.values()) abort.abort(new Error('排障助手停止'));
    for (const handle of this.handles.values()) handle.agent.cancel({ kind: 'user' });
    for (const handle of this.handles.values()) await handle.dispose();
    this.handles.clear();
  }
}

export function validateReport(task, report) {
  if (typeof report.summary !== 'string' || !report.summary.trim() || report.summary.length > 3000) throw new Error('报告摘要无效');
  for (const key of ['findings', 'hypotheses', 'nextSteps', 'limitations']) if (!Array.isArray(report[key]) || report[key].length > 30) throw new Error(`报告 ${key} 无效`);
  for (const key of ['hypotheses', 'nextSteps', 'limitations']) if (!report[key].every(x => typeof x === 'string' && x.length <= 3000)) throw new Error(`报告 ${key} 必须为文本列表`);
  if (!report.nextSteps.length) throw new Error('报告需要处理或补充验证建议');
  for (const fact of report.findings) {
    if (typeof fact.statement !== 'string' || !fact.statement.trim() || !Array.isArray(fact.evidenceIds) || !fact.evidenceIds.length || !fact.evidenceIds.every(id => Object.hasOwn(task.evidence, id))) throw new Error('事实必须引用本任务实际取得的证据 ID');
  }
}
