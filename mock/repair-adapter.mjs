export function createRepairAdapter(options) {
  const base = new URL(options.baseUrl);
  if (!['127.0.0.1', 'localhost'].includes(base.hostname) || base.protocol !== 'http:') throw new Error('演示写入适配器仅允许本机 HTTP；公司环境需接公司平台适配器');
  const request = async (route, input, signal, method = 'GET') => {
    const url = new URL(route, base);
    if (method === 'GET') for (const [key, value] of Object.entries(input)) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Demo-Repair': 'public-demo-only' }, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `模拟部署 API ${response.status}`);
    return result;
  };
  return {
    capabilities: { conditionalWrite: true, idempotency: true, publish: true },
    read: (input, signal) => request('/repair-api/read', input, signal),
    getOperation: (input, signal) => request('/repair-api/operation', input, signal),
    apply: (input, signal) => request('/repair-api/apply', input, signal, 'POST'),
    verify: (input, signal) => request('/repair-api/verify', input, signal, 'POST'),
  };
}
