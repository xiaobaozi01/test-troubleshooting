// Replace this adapter, not the troubleshooting engine, for the company chat API.
export class HttpChatAdapter {
  constructor(config) { this.config = config; this.base = new URL(config.baseUrl); }
  async request(route, options = {}) {
    const token = this.config.tokenEnv && process.env[this.config.tokenEnv];
    const response = await fetch(new URL(route, this.base), {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`群接口 ${response.status}: ${route.split('?')[0]}`);
    return response.json();
  }
  async poll(cursor, signal) {
    const result = await this.request(`/messages?after=${encodeURIComponent(cursor ?? 'latest')}`, { signal });
    if (!Array.isArray(result.messages) || typeof result.nextCursor !== 'string') throw new Error('群接口返回格式错误');
    for (const m of result.messages) {
      if (![m.id, m.groupId, m.senderId, m.text, m.timestamp].every(v => typeof v === 'string') || !Array.isArray(m.mentions)) throw new Error('群消息缺少必要字段');
    }
    return result;
  }
  async send(message, signal) {
    // A real adapter must implement idempotencyKey semantics or reconcile before retry.
    return this.request('/replies', { method: 'POST', body: JSON.stringify(message), signal });
  }
  async attachment(id) { return this.request(`/attachments/${encodeURIComponent(id)}`); }
}
