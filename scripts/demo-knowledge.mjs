// Submit a question; the actual Harness Agent must retrieve and cite the answer.
import { writeFile } from 'node:fs/promises';
const base = process.env.MOCK_URL ?? 'http://127.0.0.1:4317';
const snapshot = () => fetch(base + '/snapshot').then(r => r.json());
const initial = await snapshot();
if (!initial.runtime.ready || initial.runtime.mode !== 'mock' || !initial.runtime.knowledgeSources?.some(s => s.id === 'demo-faq')) throw new Error('请先启动模拟群和启用了 demo-faq 的 npm start');
const response = await fetch(base + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mentions: ['developer-me'], text: '@开发 只咨询演示文档：DEMO_ACCOUNT_LOCKED 应该怎么处理？请引用资料中的适用条件和复验步骤。这是资料问答，不是正在发生的故障，不用查运行日志或后台。' }) });
if (!response.ok) throw new Error(await response.text());
const first = await response.json();
console.log('已提交资料问答，等待真实 Harness Agent 检索、阅读和引用。');
const deadline = Date.now() + 240000;
let finished = false;
while (Date.now() < deadline) {
  const state = await snapshot();
  const task = state.tasks.find(t => t.rootMessageId === first.id);
  if (task?.status === 'failed') throw new Error(task.error);
  if (task?.status === 'awaiting_input') throw new Error('纯资料问答被要求补充运行信息，请检查 Agent 追问。');
  if (task?.status === 'diagnosed') {
    const report = Object.values(task.actions).find(a => a.kind === 'finish');
    if (!task.calls.some(c => c.tool === 'troubleshoot_knowledge_search') || !task.calls.some(c => c.tool === 'troubleshoot_knowledge_read')) throw new Error('缺少实际知识检索或阅读');
    const references = report.findings.flatMap(f => f.evidenceIds);
    if (!references.some(id => task.evidence[id]?.kind === 'knowledge-document')) throw new Error('没有引用实际文档正文证据');
    if (task.calls.some(c => ['troubleshoot_log_file', 'troubleshoot_status', 'troubleshoot_find_endpoint', 'troubleshoot_code_read', 'troubleshoot_code_search'].includes(c.tool) || c.tool.startsWith('bsk_'))) throw new Error('资料问答触发了不必要的运行查询');
    if (!JSON.stringify(report).includes('15')) throw new Error('未依据演示文档中的处理步骤回答');
    await writeFile('.local/knowledge-demo-result.json', JSON.stringify({ taskId: task.id, report, calls: task.calls, evidence: task.evidence }, null, 2));
    console.log(`通过：${task.id} 实际检索、阅读并引用文档，无运行日志或浏览器查询。`);
    finished = true; break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (!finished) throw new Error('资料问答验证超时');
