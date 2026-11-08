import { createHash } from 'node:crypto';
const copy = value => structuredClone(value);
const identity = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createRepairPlatform({ state, persist = async () => {} } = {}) {
  let data = state ?? { version: 1, configurations: {}, operations: {} };
  if (data.version !== 1 || !data.configurations || !data.operations) throw new Error('模拟部署状态格式无效');
  for (const env of ['test', 'staging']) for (const service of ['order-service', 'stock-service']) {
    data.configurations[`${env}/${service}`] ??= { revision: '7', activeRevision: '7', values: service === 'order-service' ? { 'spring.application.name': service, 'partner.api.base-url': `https://${env === 'test' ? 'partner-sandobx' : 'partner-staging'}.example.invalid`, 'partner.api.timeout-ms': 3000 } : { 'cache.namespace': 'test-stock' } };
  }
  let writes = Promise.resolve();
  function configuration(environment, service) {
    const value = data.configurations[`${environment}/${service}`];
    if (!value) throw new Error('模拟环境或服务不存在');
    return copy(value);
  }
  return {
    configuration,
    count: () => Object.keys(data.operations).length,
    async read({ environment, service, keys }) {
      const c = configuration(environment, service);
      if (!Array.isArray(keys) || keys.some(k => !Object.hasOwn(c.values, k))) throw new Error('模拟配置键不存在');
      return { revision: c.revision, activeRevision: c.activeRevision, values: Object.fromEntries(keys.map(k => [k, c.values[k]])), checks: service === 'order-service' ? [{ id: 'partner-status', description: '模拟运行实例使用已发布配置执行只读三方状态查询；不访问外网或修改业务数据' }] : [] };
    },
    async getOperation({ operationId }) { return copy(data.operations[operationId]?.result ?? { state: 'not_found' }); },
    async apply(request) {
      const pending = writes.then(async () => {
        const { operationId, environment, service, expectedRevision, changes, publish } = request;
        if (typeof operationId !== 'string' || !/^R-[a-f0-9]{12}$/.test(operationId) || publish !== true || !Array.isArray(changes) || !changes.length || changes.length > 10 || new Set(changes.map(c => c.key)).size !== changes.length) throw new Error('模拟修复请求无效');
        const previous = data.operations[operationId];
        if (previous) { if (previous.requestHash !== identity(request)) throw new Error('幂等键已用于不同的修复'); return copy(previous.result); }
        const c = configuration(environment, service);
        if (c.revision !== expectedRevision || changes.some(change => !Object.hasOwn(c.values, change.key) || !Object.is(c.values[change.key], change.before) || !['string', 'boolean', 'number'].includes(typeof change.after) && change.after !== null)) throw new Error('版本冲突或旧值不匹配，未保存或发布');
        const before = copy(data);
        for (const change of changes) c.values[change.key] = change.after;
        c.revision = c.activeRevision = String(Number(c.revision) + 1);
        const result = { operationId, environment, service, state: 'published', revision: c.revision, changes: copy(changes), simulated: true, publishedAt: new Date().toISOString() };
        data.configurations[`${environment}/${service}`] = c;
        data.operations[operationId] = { requestHash: identity(request), result };
        try { await persist(copy(data)); } catch (e) { data = before; throw e; }
        return copy(result);
      });
      writes = pending.catch(() => {});
      return pending;
    },
    async verify({ operationId, environment, service, checks }) {
      const op = data.operations[operationId]?.result;
      if (!op || op.environment !== environment || op.service !== service || !Array.isArray(checks) || checks.some(id => id !== 'partner-status') || service !== 'order-service') throw new Error('模拟验证项无效');
      const c = configuration(environment, service);
      // This is the simulated application contract, never production repair logic.
      const passed = c.activeRevision === op.revision && c.values['partner.api.base-url'] === 'https://partner-sandbox.example.invalid';
      return { effectiveRevision: c.activeRevision, simulated: true, observedAt: new Date().toISOString(), checks: checks.map(id => ({ id, passed, detail: `模拟只读状态请求 ${passed ? '200 OK' : '502 PARTNER_CONNECT_FAILED'}；实际使用 ${c.values['partner.api.base-url']}/v1/status，配置版本 ${c.activeRevision}。仅演示，不代表外网请求成功。` })) };
    },
  };
}

export function repairApi(platform) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith('/repair-api/')) return false;
    const reply = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    if (req.headers['x-demo-repair'] !== 'public-demo-only') { reply({ error: '仅供本机模拟适配器使用' }, 403); return true; }
    try {
      let input;
      if (req.method === 'POST') {
        let text = ''; for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 32000) throw new Error('请求过大'); }
        input = JSON.parse(text);
      }
      if (req.method === 'GET' && url.pathname === '/repair-api/read') reply(await platform.read({ environment: url.searchParams.get('environment'), service: url.searchParams.get('service'), keys: JSON.parse(url.searchParams.get('keys')) }));
      else if (req.method === 'GET' && url.pathname === '/repair-api/operation') reply(await platform.getOperation({ operationId: url.searchParams.get('operationId') }));
      else if (req.method === 'POST' && url.pathname === '/repair-api/apply') reply(await platform.apply(input));
      else if (req.method === 'POST' && url.pathname === '/repair-api/verify') reply(await platform.verify(input));
      else reply({ error: 'not found' }, 404);
    } catch (e) { reply({ error: e.message }, 409); }
    return true;
  };
}
