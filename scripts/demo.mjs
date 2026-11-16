// Integration check: this uses the actual Harness model, never a scripted diagnosis.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const base = process.env.MOCK_URL ?? 'http://127.0.0.1:4317';
const snapshot = async () => { const r = await fetch(`${base}/snapshot`); if (!r.ok) throw new Error('模拟群服务不可用'); return r.json(); };
const send = async input => { const r = await fetch(`${base}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }); if (!r.ok) throw new Error(await r.text()); return r.json(); };
const initial = await snapshot();
if (!initial.runtime.ready) throw new Error('请先运行 npm run mock 和 npm start，并等待插件就绪');
if (initial.runtime.mode !== 'mock') throw new Error('demo 只允许运行于 mock 模式');
if (process.argv.includes('--resume')) {
  const saved = JSON.parse(await readFile('.local/demo-result.json', 'utf8'));
  const before = initial.tasks.find(t => t.id === saved.taskId);
  if (!before) throw new Error('没有找到上一次 demo 的任务');
  let followup = before.messages.find(m => !m.handled);
  if (followup) await send({ text: '/继续', senderId: 'developer-me', mentions: [], replyTo: before.rootMessageId });
  else followup = await send({ text: '请基于刚才的证据简短总结故障原因、建议处理方式，以及运行代码版本是否已经确认。已有日志足够，无需重复查询。', mentions: [], replyTo: before.rootMessageId });
  const end = Date.now() + 180000;
  let ok = false;
  while (Date.now() < end) {
    const state = await snapshot();
    const task = state.tasks.find(t => t.id === before.id);
    if (task.status === 'failed' && task.failedAt !== before.failedAt) throw new Error(task.error);
    if (task.messages.find(m => m.id === followup.id)?.handled) {
      if (task.sessionId !== before.sessionId || task.actions[followup.id]?.kind !== 'finish') throw new Error('没有恢复到原诊断会话');
      await writeFile('.local/resume-result.json', JSON.stringify({ taskId: task.id, sessionId: task.sessionId, report: task.actions[followup.id] }, null, 2));
      console.log(`通过：${task.id} 在原 Harness 会话中继续处理补充消息。`); ok = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ok) throw new Error('恢复会话检查超时');
} else {
console.log('提交模拟问题（将调用你已配置的 Harness 模型）…');
const first = await send({ text: '@开发 测试环境下单失败，页面只提示 ORDER_CREATE_FAILED，请帮忙看看。[模拟截图]', mentions: ['developer-me'], attachments: [{ id: 'demo-error', name: '订单报错.png' }] });
let replied = false, finished = false;
const deadline = Date.now() + 360000;
while (Date.now() < deadline) {
  const state = await snapshot();
  const task = state.tasks.find(t => t.rootMessageId === first.id);
  if (task?.status === 'failed') throw new Error(`真实 Agent 排查失败：${task.error}`);
  if (task?.status === 'awaiting_input' && !replied) {
    const question = state.messages.find(m => m.replyTo === first.id && m.text.startsWith(`#${task.id} 需要补充信息：`));
    if (question) {
      console.log(`Agent 已追问：${question.text}`);
      await send({ text: '环境 test，失败接口 POST /api/orders，时间 2026-11-09T02:00:00+08:00，请求 traceId=demo-order-101，商品 SKU-DEMO-1。', mentions: [], replyTo: question.id });
      replied = true; console.log('已在同一任务补充接口、时间和 traceId，等待跨服务排查…');
    }
  }
  if (task?.status === 'diagnosed') {
    if (!replied) throw new Error('缺少请求线索时 Agent 没有先追问');
    if (!task.calls.some(c => c.tool === 'troubleshoot_find_endpoint')) throw new Error('Agent 没有跨代码仓检索接口所属服务');
    const services = new Set(task.calls.filter(c => c.tool === 'troubleshoot_log_file').map(c => c.args.service));
    if (!services.has('order-service') || !services.has('stock-service')) throw new Error('Agent 未完成入口和下游日志查询');
    const report = Object.values(task.actions).find(a => a.kind === 'finish');
    if (!JSON.stringify(report).includes('CACHE_NAMESPACE')) throw new Error('报告未定位到实际配置异常');
    await mkdir('.local', { recursive: true });
    await writeFile('.local/demo-result.json', JSON.stringify({ taskId: task.id, actualModel: state.runtime.model, report, toolCalls: task.calls, evidence: task.evidence }, null, 2));
    console.log(`通过：${task.id} 完成真实模型追问、跨服务查询和证据报告。详情：.local/demo-result.json`);
    finished = true; break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!finished) throw new Error('等待真实模型排障超过6分钟，请查看模拟群页面和 Harness 日志');
}
