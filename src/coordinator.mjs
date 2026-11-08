import { randomUUID } from 'node:crypto';

const messageKey = m => `${m.groupId}:${m.id}`;
export class Coordinator {
  constructor({ store, chat, runner, config, log = console.log }) {
    Object.assign(this, { store, chat, runner, config, log });
    this.polling = false; this.working = false; this.sending = false; this.failures = 0; this.stopped = false;
  }
  taskForReply(m) {
    const taskId = this.store.data.seen[`${m.groupId}:${m.replyTo}`];
    const explicit = /#(T-[a-f0-9]{8})\b/i.exec(m.text)?.[1];
    const t = this.store.data.tasks[taskId || explicit];
    return t?.groupId === m.groupId ? t : undefined;
  }
  async ingest(messages, nextCursor) {
    for (const m of messages) {
      const key = messageKey(m);
      if (Object.hasOwn(this.store.data.seen, key)) continue;
      this.store.data.seen[key] = null;
      if (!this.config.chat.groupIds.includes(m.groupId) || m.senderId === this.config.chat.botId) continue;
      let task = this.taskForReply(m);
      if (!task && m.mentions.includes(this.config.chat.ownerId)) {
        const id = `T-${randomUUID().slice(0, 8)}`;
        task = this.store.data.tasks[id] = { id, groupId: m.groupId, rootMessageId: m.id, sessionId: `troubleshoot-${randomUUID()}`, started: false, status: 'queued', messages: [], evidence: {}, actions: {}, calls: [] };
      }
      if (!task) continue; // Never assign an unrelated group message by guessing.
      this.store.data.seen[key] = task.id;
      const command = m.text.trim();
      if (m.senderId === this.config.chat.ownerId && ['/暂停', '/继续', '/结束'].includes(command)) {
        task.status = { '/暂停': 'paused', '/继续': 'queued', '/结束': 'closed' }[command];
        if (command !== '/继续') this.runner.cancel?.(task.id);
        this.queueReply(task, m.id, `任务 #${task.id} ${command.slice(1)}。`, `control:${m.id}`);
        continue;
      }
      if (task.status === 'closed') continue;
      task.messages.push({ ...m, handled: false });
      if (task.status !== 'paused') task.status = 'queued';
    }
    this.store.data.cursor = nextCursor;
    await this.store.save(); // Queue + dedup + cursor are one durable snapshot.
  }
  queueReply(task, replyTo, text, actionId) {
    const idempotencyKey = `${task.id}:${actionId}`;
    if (!this.store.data.outbox.some(x => x.idempotencyKey === idempotencyKey)) {
      this.store.data.outbox.push({ idempotencyKey, taskId: task.id, groupId: task.groupId, replyTo, text, senderId: this.config.chat.botId, sent: false });
    }
  }
  async pollOnce() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const result = await this.chat.poll(this.store.data.cursor);
      await this.ingest(result.messages, result.nextCursor);
      this.failures = 0;
    } catch (e) { this.failures++; this.log(`轮询失败（将退避重试）：${e.message}`); }
    finally { this.polling = false; }
  }
  async flushOutbox() {
    if (this.sending) return;
    this.sending = true;
    try {
      for (const item of this.store.data.outbox.filter(x => !x.sent)) {
        const result = await this.chat.send(item);
        if (typeof result.id !== 'string') throw new Error('发送回复没有返回消息 ID');
        item.sent = true; item.messageId = result.id;
        this.store.data.seen[`${item.groupId}:${result.id}`] = item.taskId;
        await this.store.save();
      }
    } catch (e) { this.log(`回复暂未发送（已保存在本地）：${e.message}`); }
    finally { this.sending = false; }
  }
  async workOnce() {
    if (this.working || this.stopped) return;
    const task = Object.values(this.store.data.tasks).find(t => !['paused', 'closed', 'failed'].includes(t.status) && t.messages.some(m => !m.handled));
    if (!task) return;
    this.working = true;
    const message = task.messages.find(m => !m.handled);
    task.status = 'running'; delete task.error; delete task.failedAt;
    await this.store.save();
    try {
      const action = task.actions[message.id] ?? await this.runner.run(task, message);
      if (['paused', 'closed'].includes(task.status)) return;
      if (!action || !['ask', 'finish'].includes(action.kind)) throw new Error('Agent 没有提交有效的追问或诊断结果');
      task.actions[message.id] = action;
      task.status = action.kind === 'ask' ? 'awaiting_input' : 'diagnosed';
      const text = action.kind === 'ask' ? `#${task.id} 需要补充信息：\n${action.question}` : formatReport(task.id, action);
      this.queueReply(task, message.id, text, `result:${message.id}`);
      message.handled = true;
      await this.store.save();
    } catch (e) {
      if (['paused', 'closed'].includes(task.status)) return;
      task.status = 'failed'; task.error = e.message; task.failedAt = new Date().toISOString();
      this.log(`任务 ${task.id} 失败：${e.stack ?? e.message}`);
      this.queueReply(task, message.id, `#${task.id} 自动排查未完成：${e.message}\n开发可回复 /继续 重试，或接管人工排查。`, `error:${message.id}`);
      await this.store.save();
    } finally { this.working = false; }
  }
  start() {
    const cycle = async () => {
      if (this.stopped) return;
      await this.pollOnce();
      void this.workOnce().catch(e => this.log(`排障队列异常：${e.message}`));
      void this.flushOutbox().catch(e => this.log(`发件队列异常：${e.message}`));
      if (!this.stopped) this.timer = setTimeout(cycle, Math.min(this.config.pollIntervalMs * 2 ** Math.min(this.failures, 5), 60000));
    };
    void cycle();
  }
  async stop() {
    this.stopped = true; clearTimeout(this.timer);
    await this.runner.dispose?.();
  }
}

export function formatReport(id, action) {
  const facts = action.findings.map(f => `- ${f.statement} [${f.evidenceIds.join(', ')}]`).join('\n');
  return `#${id} 排障结果\n${action.summary}\n\n已确认事实\n${facts || '暂无'}\n\n候选原因\n${action.hypotheses.map(x => `- ${x}`).join('\n') || '无额外推测'}\n\n建议处理与验证\n${action.nextSteps.map(x => `- ${x}`).join('\n')}\n\n限制\n${action.limitations.map(x => `- ${x}`).join('\n') || '无额外说明'}\n\n本次仅执行查询，未修改服务或数据。`;
}
