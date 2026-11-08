// The model must decide how to log in and navigate using native BrowserSkill.
import { writeFile } from 'node:fs/promises';
const base = process.env.MOCK_URL ?? 'http://127.0.0.1:4317';
const snapshot = () => fetch(base + '/snapshot').then(r => r.json());
const initial = await snapshot();
if (!initial.runtime.ready || !initial.runtime.deploymentBackend || initial.runtime.mode !== 'mock') throw new Error('请先启动模拟群，并使用 TROUBLESHOOT_CONFIG=config/browser-demo.json npm start');
const first = await fetch(base + '/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mentions: ['developer-me'], text: '@开发 test 环境 GET /api/partner/status 调三方失败，发生在 2026-11-09T03:00:00+08:00，traceId=demo-partner-202。请查日志、相关代码及接入约定，再登录部署后台查看对应服务 YAML 配置核对三方地址，给出证据与建议；不要修改或发布。' }) }).then(r => r.json());
console.log('已提交三方地址异常；由 Harness Agent 自主操作 BrowserSkill 登录并查配置。');
const deadline = Date.now() + 480000;
while (Date.now() < deadline) {
  const state = await snapshot();
  const task = state.tasks.find(t => t.rootMessageId === first.id);
  if (task?.status === 'failed') throw new Error(task.error);
  if (task?.status === 'awaiting_input') throw new Error('Agent 需要补充信息或浏览器连接，请查看群内追问；尚未验证完整浏览器链路。');
  if (task?.status === 'diagnosed') {
    const response = await fetch(base + '/deployment-audit');
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('模拟后台审计接口未返回 JSON');
    const audit = await response.json();
    const report = Object.values(task.actions).find(a => a.kind === 'finish');
    const browserEvidence = Object.values(task.evidence).filter(e => e.kind === 'deployment-browser');
    if (!task.calls.some(c => c.tool === 'bsk_interact') || !browserEvidence.length) throw new Error('没有实际浏览器操作与观察证据');
    if (!audit.configurationViews.some(v => v.environment === 'test' && v.service === 'order-service')) throw new Error('未实际查看目标配置页');
    if (audit.writes) throw new Error('发生了非只读操作');
    if (!JSON.stringify(report).includes('partner-sandobx')) throw new Error('报告未识别实际的错误地址');
    await writeFile('.local/browser-demo-result.json', JSON.stringify({ taskId: task.id, report, browserEvidence, audit, calls: task.calls }, null, 2));
    console.log(`通过：${task.id} 实际浏览器登录/查看 YAML，并与代码及日志交叉验证；没有配置写入。`);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
if (Date.now() >= deadline) throw new Error('真实浏览器模拟超时');
