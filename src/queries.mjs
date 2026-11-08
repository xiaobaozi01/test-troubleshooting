import { readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { RepositoryIndex, instanceId, normalizeName, endpointMatch } from './discovery.mjs';
import { syncRepositories } from './repository-sync.mjs';
const execFileAsync = promisify(execFile);

export function redact(text) {
  return String(text)
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi, '$1: [REDACTED]')
    .replace(/\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b(["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1$2[REDACTED]');
}
export function selectLogRecords(text, { since, until, traceId, query = '' }) {
  const records = [];
  let current;
  text.split('\n').forEach((line, i) => {
    const stamp = /^(\d{4}-\d\d-\d\d[T ][\d:.]+(?:Z|[+-]\d\d:\d\d)?)/.exec(line);
    if (stamp) { current = { time: Date.parse(stamp[1]), lines: [] }; records.push(current); }
    if (current) current.lines.push({ line: i + 1, text: line });
  });
  return records.filter(r => r.time >= Date.parse(since) && r.time <= Date.parse(until))
    .filter(r => !traceId || new RegExp(`\\b(?:traceId|trace_id|requestId|request_id)=${escapeRegex(traceId)}(?=\\s|$|[,;])`).test(r.lines.map(l => l.text).join('\n')))
    .filter(r => !query || r.lines.some(l => l.text.includes(query)))
    .flatMap(r => r.lines).slice(0, 300);
}
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,200}$/.test(value);

export class QueryTools {
  constructor({ root, catalog, mode, runCommand = execFileAsync }) {
    Object.assign(this, { root, catalog, mode, runCommand });
    this.index = new RepositoryIndex(root, catalog); this.inventories = new Map();
  }
  async prepareForDiagnosis(signal) {
    // Rebuild after every sync, including failures after a partial update.
    try { return await syncRepositories(this.root, this.catalog, this.mode, signal); }
    finally { this.index.snapshot = null; }
  }
  async discover(environment, signal, refresh = false) {
    const code = await this.index.scan(signal, refresh);
    const key = environment ?? '*';
    let inventory = this.inventories.get(key);
    if (refresh || !inventory || Date.now() - inventory.builtAt >= 30000) {
      const services = (this.catalog.services ?? []).filter(s => !environment || s.environment === environment).map(s => ({ ...s, instanceId: instanceId(s.environment, s.host, s.container), discoveredBy: 'explicit-override' }));
      const warnings = [];
      // Query only administrator-configured hosts, never hostnames found in logs.
      const hosts = (this.catalog.hosts ?? []).filter(h => !environment || h.environment === environment);
      const inspectHost = async host => {
        signal?.throwIfAborted();
        try {
          if (!safeName(host.host) || !this.catalog.environments.includes(host.environment)) throw new Error('主机别名或环境无效');
          const text = this.mode === 'mock'
            ? await readFile(path.resolve(this.root, host.mockContainersFile), { encoding: 'utf8', signal })
            : (await this.runCommand('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', host.host, "docker ps -a --format '{{json .}}'"], { signal, timeout: 15000, maxBuffer: 2 * 1024 * 1024 })).stdout;
          for (const line of text.split('\n').filter(l => l.trim())) {
            const row = JSON.parse(line);
            if (!safeName(row.Names) || typeof row.Image !== 'string') throw new Error('容器列表格式无效');
            const compose = /(?:^|,)com\.docker\.compose\.service=([^,]+)/.exec(row.Labels ?? '')?.[1];
            const image = row.Image.split('/').at(-1).split('@')[0].split(':')[0];
            const id = compose && safeName(compose) ? compose : safeName(image) ? image : row.Names;
            if (services.some(s => s.environment === host.environment && s.host === host.host && s.container === row.Names)) continue;
            services.push({ id, environment: host.environment, host: host.host, container: row.Names, instanceId: instanceId(host.environment, host.host, row.Names), image: row.Image, state: row.State, discoveredBy: compose ? 'docker-compose-label' : 'docker-image-candidate', versionVerified: false, ...(this.mode === 'mock' ? { logFile: row.MockLogFile } : {}) });
          }
        } catch (e) { signal?.throwIfAborted(); warnings.push(`主机发现失败 ${host.host}：${e.code ?? e.message}`); }
      };
      for (let i = 0; i < hosts.length; i += 4) await Promise.all(hosts.slice(i, i + 4).map(inspectHost));
      inventory = { builtAt: Date.now(), services: services.sort((a, b) => `${a.host}/${a.container}`.localeCompare(`${b.host}/${b.container}`)), warnings };
      this.inventories.set(key, inventory);
    }
    const services = inventory.services.map(s => {
      const names = [s.id, s.container, s.image?.split('/').at(-1).split(':')[0]].filter(Boolean).map(normalizeName);
      const repositories = code.repositories.filter(r => s.repository ? path.resolve(this.root, s.repository) === r.root : r.aliases.some(alias => names.includes(normalizeName(alias))));
      return { ...s, repositories: repositories.map(r => ({ id: r.id, name: r.name })), repository: s.repository ?? (repositories.length === 1 ? repositories[0].root : undefined), repositoryAssociation: s.repository ? 'explicit-override' : repositories.length === 1 ? 'name-candidate' : repositories.length > 1 ? 'ambiguous' : 'unresolved' };
    });
    return { services, code, scannedAt: new Date(inventory.builtAt).toISOString(), warnings: [...inventory.warnings, ...code.warnings] };
  }
  async service(environment, service, selectedInstance, signal) {
    const found = (await this.discover(environment, signal)).services.filter(s => s.id === service && (!selectedInstance || s.instanceId === selectedInstance));
    if (!found.length) throw new Error('服务不在已发现的环境目录中；请先发现服务');
    if (found.length > 1) throw new Error(`服务有多个实例，请明确 instanceId：${found.map(s => `${s.instanceId} (${s.host}/${s.container})`).join(', ')}`);
    return found[0];
  }
  async services({ environment, query = '', refresh = false }, signal) {
    const discovered = await this.discover(environment, signal, refresh);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return { environments: this.catalog.environments, services: discovered.services.filter(s => !terms.length || terms.some(term => JSON.stringify([s.id, s.description, s.container, s.image]).toLowerCase().includes(term))).map(({ logFile, repository, ...s }) => ({ ...s, repositoryConfigured: Boolean(repository) })), warnings: discovered.warnings, scannedAt: discovered.scannedAt, note: '无需手填接口。使用 troubleshoot_find_endpoint 搜索全部代码仓；名称关联代码仓只是候选，版本未核实。' };
  }
  async findEndpoint({ environment, endpoint, method, refresh = false }, signal) {
    if (typeof endpoint !== 'string' || !endpoint.trim() || endpoint.length > 500) throw new Error('请输入接口路径或URL');
    const requested = endpoint.startsWith('http://') || endpoint.startsWith('https://') ? new URL(endpoint).pathname : endpoint.split('?')[0];
    if (!requested.startsWith('/')) throw new Error('接口路径必须以 / 开始');
    const d = await this.discover(environment, signal, refresh), matches = [], hints = [];
    for (const file of d.code.files) {
      signal?.throwIfAborted();
      const repository = d.code.repositories.find(r => r.id === file.repository);
      const instances = d.services.filter(s => s.repositories.some(r => r.id === repository.id)).map(s => ({ service: s.id, instanceId: s.instanceId, host: s.host, container: s.container, association: s.repositoryAssociation }));
      for (const route of file.routes) {
        const match = endpointMatch(route.path, requested);
        if (match && (!method || route.method === 'ANY' || route.method === method.toUpperCase())) matches.push({ repository: repository.id, repositoryName: repository.name, file: file.file, ...route, match, instances, versionVerified: false });
      }
      const fragment = requested.split('/').filter(Boolean).filter(x => !/^\d+$/.test(x)).at(-1);
      if (hints.length < 30 && fragment) file.text.split('\n').forEach((line, i) => {
        if (hints.length < 30 && (line.includes(requested) || line.includes('/' + fragment))) hints.push({ repository: repository.id, file: file.file, line: i + 1, text: redact(line.trim()).slice(0, 400), instances, note: '文本候选，可能是网关 Path/RewritePath 配置或客户端调用，需读上下文验证。' });
      });
    }
    return { endpoint: requested, matches: matches.slice(0, 50), hints, repositories: d.code.repositories.map(r => ({ id: r.id, name: r.name })), warnings: d.warnings, truncated: d.code.truncated || matches.length > 50, scannedAt: new Date(d.code.builtAt).toISOString(), note: '匹配仅是代码线索，不证明实际部署映射；动态路由、网关改写需用代码上下文及日志核实。未关联实例时可用 repository 参数查代码，无需人工维护接口表。' };
  }
  async logs(args, signal) {
    const { environment, service, since, until, traceId, query } = args;
    const s = await this.service(environment, service, args.instanceId, signal);
    const start = Date.parse(since), end = Date.parse(until);
    if (![since, until].every(v => typeof v === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(v)) || !Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 15 * 60000) throw new Error('日志窗口必须包含时区，且不超过 15 分钟');
    let text;
    if (this.mode === 'mock') text = await readFile(path.resolve(this.root, s.logFile), { encoding: 'utf8', signal });
    else {
      if (!safeName(s.host) || !safeName(s.container)) throw new Error('SSH 主机或容器名无效');
      // Only administrator-configured SSH aliases and validated names reach the remote shell.
      const command = `docker logs --timestamps --since '${new Date(start).toISOString()}' --until '${new Date(end).toISOString()}' --tail 2000 '${s.container}' 2>&1`;
      const result = await this.runCommand('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', s.host, command], { signal, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
      text = normalizeDockerLogs(result.stdout);
    }
    return { service, environment, host: s.host, container: s.container, correlation: traceId ? 'request-id' : 'candidate-by-time-and-fields', lines: selectLogRecords(text, { since, until, traceId, query }).map(l => ({ ...l, text: redact(l.text) })), note: '仅查询当前容器可获取日志；空结果不能证明服务没有异常。最多返回 300 行。' };
  }
  async status({ environment, service, instanceId: selectedInstance }, signal) {
    const s = await this.service(environment, service, selectedInstance, signal);
    if (this.mode === 'mock') return { environment, service, host: s.host, container: s.container, running: s.state ? s.state === 'running' : true, simulated: true, note: '容器运行不代表业务接口正常。' };
    if (!safeName(s.host) || !safeName(s.container)) throw new Error('SSH 主机或容器名无效');
    const result = await this.runCommand('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', s.host, `docker inspect --format '{{json .State}}' '${s.container}'`], { signal, timeout: 15000, maxBuffer: 65536 });
    return { environment, service, state: JSON.parse(result.stdout) };
  }
  async repoFile(s, relative) {
    if (!s.repository) throw new Error('该服务尚未配置本地代码仓');
    if (path.isAbsolute(relative)) throw new Error('代码路径必须相对代码仓');
    const root = await realpath(path.resolve(this.root, s.repository));
    const file = await realpath(path.resolve(root, relative));
    if (file !== root && !file.startsWith(root + path.sep)) throw new Error('代码路径越出配置的代码仓');
    return file;
  }
  async codeOwner({ environment, service, instanceId, repository }, signal) {
    if (repository) {
      const code = await this.index.scan(signal);
      const known = code.repositories.find(r => r.id === repository);
      if (!known) throw new Error('代码仓不在已配置根目录的发现结果中');
      return { repository: known.root, versionVerified: false };
    }
    return this.service(environment, service, instanceId, signal);
  }
  async codeRead({ environment, service, instanceId, repository, file, startLine = 1, limit = 100 }, signal) {
    const s = await this.codeOwner({ environment, service, instanceId, repository }, signal);
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('无效的代码行范围');
    const text = await readFile(await this.repoFile(s, file), { encoding: 'utf8', signal });
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('文件过大，请缩小检索范围');
    return { service: service ?? null, repository: s.repository, file, versionVerified: s.versionVerified === true, lines: text.split('\n').slice(startLine - 1, startLine - 1 + limit).map((text, i) => ({ line: startLine + i, text: redact(text) })) };
  }
  async codeSearch({ environment, service, instanceId, repository, query }, signal) {
    if (!query?.trim() || query.length > 200) throw new Error('请提供不超过 200 字符的代码搜索词');
    const s = await this.codeOwner({ environment, service, instanceId, repository }, signal);
    const root = await this.repoFile(s, '.');
    const matches = []; let inspected = 0;
    const visit = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        signal?.throwIfAborted();
        if (matches.length >= 30 || inspected >= 2000) return;
        if (entry.name.startsWith('.') || ['node_modules', 'target', 'build', '__pycache__'].includes(entry.name) || entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { await visit(file); continue; }
        if (!/\.(?:java|py|js|mjs|ts|json|ya?ml|properties|xml|md)$/.test(entry.name)) continue;
        inspected++;
        const text = await readFile(file, { encoding: 'utf8', signal });
        if (Buffer.byteLength(text) > 1024 * 1024) continue;
        text.split('\n').forEach((line, i) => { if (matches.length < 30 && line.includes(query)) matches.push({ file: path.relative(root, file), line: i + 1, text: redact(line) }); });
      }
    };
    await visit(root);
    return { service: service ?? null, repository: s.repository, versionVerified: s.versionVerified === true, matches, truncated: matches.length >= 30 || inspected >= 2000 };
  }
}

export function evidence(task, kind, args, result) {
  const id = `E-${createHash('sha256').update(JSON.stringify([kind, args, result])).digest('hex').slice(0, 10)}`;
  task.evidence[id] = { id, kind, args, result };
  return { evidenceId: id, ...result };
}

// Docker prefixes every physical line, including stack frames. Remove that wrapper
// from continuation lines so trace filtering preserves their owning exception.
export function normalizeDockerLogs(text) {
  return text.split('\n').map(line => {
    const match = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) (.*)$/.exec(line);
    if (!match) return line;
    const rest = match[2];
    if (/^\d{4}-\d\d-\d\d[T ]/.test(rest)) return rest;
    if (/^(\s+|Traceback|Caused by:|[\w.]+(?:Exception|Error):)/.test(rest)) return rest;
    return line;
  }).join('\n');
}
