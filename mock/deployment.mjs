import { randomUUID } from 'node:crypto';
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const page = (title, content) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title} · 模拟部署平台</title><style>body{font:16px system-ui;background:#f2f5f9;color:#26384f;padding:40px}.card{max-width:850px;margin:auto;background:white;padding:28px;border:1px solid #dce4ef;border-radius:14px}h1{font-size:24px}label{display:block;margin:18px 0 6px}input,select,textarea{font:15px system-ui;padding:10px;border:1px solid #b8c6d8;border-radius:6px}input{width:300px}button,a{display:inline-block;margin:16px 8px 8px 0;padding:10px 16px;background:#275fc7;color:white;border:0;border-radius:6px;text-decoration:none;cursor:pointer}small{color:#738298}table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:12px;border-bottom:1px solid #dde5f0}pre{padding:20px;background:#f3f6fa;white-space:pre-wrap}p{line-height:1.7}</style><div class="card"><small>本机演示数据 · 只读配置查看</small><h1>${title}</h1>${content}</div></html>`;
export function createDeploymentPortal(options) {
  const sessions = new Set();
  const configurations = {
    test: {
      'order-service': { revision: 1, values: { 'partner.api.base-url': 'https://partner-sandobx.example.invalid', 'partner.api.timeout-ms': 3000 } },
      'stock-service': { revision: 1, values: { 'cache.namespace': '' } },
    },
    staging: {
      'order-service': { revision: 2, values: { 'partner.api.base-url': 'https://partner-staging.example.invalid', 'partner.api.timeout-ms': 3000 } },
      'stock-service': { revision: 2, values: { 'cache.namespace': 'stock-cache-staging' } },
    },
  };
  const configuration = (environment, service) => structuredClone(configurations[environment][service]);
  const audit = { successfulLogins: 0, failedLogins: 0, configurationViews: [], blockedWrites: 0, get writes() { return 0; } };
  return { audit, configuration, async handle(req, res, url) {
    if (url.pathname !== '/deploy' && !url.pathname.startsWith('/deploy/')) return false;
    const html = (text, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text); };
    const redirect = location => { res.writeHead(303, { Location: location }); res.end(); };
    if (req.method === 'POST' && url.pathname === '/deploy/login') {
      let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 8000) throw new Error('表单过大'); }
      const fields = new URLSearchParams(text);
      if (fields.get('username') !== 'demo' || fields.get('password') !== 'demo-only') {
        audit.failedLogins++; html(page('登录失败', '<p>演示账号或密码不正确。</p><a href="/deploy">返回登录</a>'), 401); return true;
      }
      const token = randomUUID(); sessions.add(token); audit.successfulLogins++;
      res.writeHead(303, { 'Set-Cookie': `deploy_demo=${token}; Path=/deploy; HttpOnly; SameSite=Strict`, Location: '/deploy' }); res.end(); return true;
    }
    const token = /(?:^|;\s*)deploy_demo=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (!sessions.has(token)) {
      const nonce = randomUUID().slice(0, 8);
      html(page('登录部署管理平台', `<p>这是模拟后台。演示账号：<b>demo</b>，演示密码：<b>demo-only</b>，均为公开测试数据。</p><form method="post" action="/deploy/login"><label for="u-${nonce}">账号</label><input id="u-${nonce}" name="username" autocomplete="username" required><label for="p-${nonce}">密码</label><input id="p-${nonce}" name="password" type="password" autocomplete="current-password" required><p><button type="submit">登录</button></p></form>`)); return true;
    }
    if (req.method !== 'GET') { audit.blockedWrites++; html(page('只读演示', '<p>浏览器页面仅供查看，不提供保存或发布操作。</p>'), 405); return true; }
    if (url.pathname === '/deploy') {
      html(page('服务部署管理', '<p>当前登录：demo · 查看服务配置</p><form method="get" action="/deploy/services"><label for="env">环境</label><select id="env" name="env"><option value="staging">预发布 staging</option><option value="test">测试 test</option></select><label for="q">服务名称</label><input id="q" name="q" placeholder="输入服务名称，可留空"><p><button type="submit">查询服务</button></p></form>')); return true;
    }
    const environment = url.searchParams.get('env');
    if (!['test', 'staging'].includes(environment)) { html(page('环境无效', '<a href="/deploy">重新选择环境</a>'), 400); return true; }
    if (url.pathname === '/deploy/services') {
      const query = url.searchParams.get('q') ?? '';
      const rows = ['order-service', 'stock-service'].filter(s => s.includes(query)).map(service => `<tr><td>${service}</td><td>${environment}</td><td>运行中</td><td><a href="/deploy/config?env=${environment}&service=${service}">查看配置</a></td></tr>`).join('');
      html(page('服务列表', `<p>当前环境：<strong>${environment}</strong></p><table><tr><th>服务</th><th>环境</th><th>状态</th><th>操作</th></tr>${rows}</table><a href="/deploy">返回筛选</a>`)); return true;
    }
    if (url.pathname === '/deploy/config') {
      const service = url.searchParams.get('service');
      if (!['order-service', 'stock-service'].includes(service)) { html(page('服务不存在', '<a href="/deploy">返回</a>'), 404); return true; }
      audit.configurationViews.push({ environment, service, at: new Date().toISOString() });
      const c = configuration(environment, service);
      const yaml = service === 'order-service' ? `spring:\n  application:\n    name: order-service\npartner:\n  api:\n    base-url: ${c.values['partner.api.base-url']}\n    timeout-ms: ${c.values['partner.api.timeout-ms']}\n` : `cache:\n  namespace: ${c.values['cache.namespace']}\n`;
      html(page('服务配置 · YAML', `<p>服务：<strong>${service}</strong>　环境：<strong>${environment}</strong></p><p>配置版本：${c.revision} · 平台记录：已发布。是否被运行进程使用仍需日志核实。</p><pre aria-label="服务 YAML 配置">${escape(yaml)}</pre><p>本页仅供查看，没有保存或发布按钮。</p><a href="/deploy/services?env=${environment}">返回服务列表</a>`)); return true;
    }
    redirect('/deploy'); return true;
  } };
}
