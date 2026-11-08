import { readdir, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const skip = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', '.local']);
const markers = new Set(['.git', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'pyproject.toml', 'requirements.txt', 'package.json']);
const quoted = value => [...value.matchAll(/["']([^"']*)["']/g)].map(m => m[1]);
const joinRoute = (a, b) => '/' + [a, b].join('/').split('/').filter(Boolean).join('/');
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
export const instanceId = (environment, host, container) => 'I-' + createHash('sha256').update(JSON.stringify([environment, host, container])).digest('hex').slice(0, 12);
export const normalizeName = name => name.toLowerCase().replace(/[^a-z0-9]/g, '');

// A conservative literal-route extractor, not a Java/Python interpreter.
export function extractRoutes(source, file) {
  const routes = [];
  if (file.endsWith('.java')) {
    const text = source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, token => token.startsWith('/') ? token.replace(/[^\n]/g, ' ') : token);
    const declarations = [...text.matchAll(/\b(?:class|interface)\s+\w+/g)];
    const boundary = declarations[0]?.index ?? 0;
    const matches = [...text.matchAll(/@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\s*(?:\(([^)]*)\))?/g)];
    const paths = m => {
      const body = m[2] ?? '';
      if (body.includes('+') || body.includes('${')) return [];
      const attr = /\b(?:path|value)\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/.exec(body)?.[1];
      if (attr) return quoted(attr);
      if (/^\s*["'{]/.test(body)) return quoted(body.split(/\b(?:method|produces|consumes|params|headers)\s*=/)[0]);
      return body.trim() && !/\b(?:method|produces|consumes|params|headers)\s*=/.test(body) ? [] : [''];
    };
    const classMapping = matches.filter(m => m.index < boundary && m[1] === 'RequestMapping').at(-1);
    const prefixes = declarations.length <= 1 && classMapping ? paths(classMapping) : [''];
    for (const m of matches.filter(m => m.index > boundary)) {
      const methods = m[1] === 'RequestMapping' ? [...(m[2] ?? '').matchAll(/RequestMethod\.(\w+)/g)].map(x => x[1]) : [m[1].replace('Mapping', '').toUpperCase()];
      for (const prefix of prefixes) for (const suffix of paths(m)) for (const method of methods.length ? methods : ['ANY']) {
        routes.push({ method, path: joinRoute(prefix, suffix), line: lineAt(text, m.index), source: 'spring-literal', note: '静态候选；尚未确认网关改写、继承映射、运行配置或部署版本。' });
      }
    }
  } else if (file.endsWith('.py')) {
    const prefixes = new Map([...source.matchAll(/(\w+)\s*=\s*APIRouter\s*\(([^)]*)\)/g)].map(m => [m[1], /prefix\s*=\s*["']([^"']*)["']/.exec(m[2])?.[1] ?? '']));
    for (const m of source.matchAll(/^\s*@([\w]+)\.(get|post|put|delete|patch|options|head)\s*\(\s*["']([^"']+)["']/gm)) {
      routes.push({ method: m[2].toUpperCase(), path: joinRoute(prefixes.get(m[1]) ?? '', m[3]), line: lineAt(source, m.index + m[0].indexOf('@')), source: 'python-literal', note: '静态候选；未展开跨文件 include_router、动态前缀或部署版本。' });
    }
  }
  return routes;
}

export class RepositoryIndex {
  constructor(root, catalog) { this.root = root; this.catalog = catalog; this.snapshot = null; }
  async scan(signal, refresh = false) {
    if (!refresh && this.snapshot && Date.now() - this.snapshot.builtAt < 30000) return this.snapshot;
    const repositories = new Map(), files = [], warnings = [];
    let visited = 0, directories = 0, bytes = 0, truncated = false;
    const walk = async (directory, owner, depth) => {
      signal?.throwIfAborted();
      if (visited >= 10000 || directories++ >= 5000 || depth > 25) { truncated = true; return; }
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.some(e => markers.has(e.name)) || !owner) {
        owner = directory;
        repositories.set(owner, { id: owner, name: path.basename(owner), aliases: [path.basename(owner)], root: owner, versionVerified: false });
      }
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (visited >= 10000) { truncated = true; break; }
        if (skip.has(entry.name) || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) { await walk(target, owner, depth + 1); continue; }
        visited++;
        if (!/\.(java|py|ya?ml|properties|xml|json)$/.test(entry.name)) continue;
        const size = (await stat(target)).size;
        if (size > 1024 * 1024) { warnings.push(`文件过大未索引：${target}`); continue; }
        if (bytes + size > 32 * 1024 * 1024) { truncated = true; continue; }
        bytes += size;
        const text = await readFile(target, { encoding: 'utf8', signal });
        const repository = repositories.get(owner);
        const name = /spring\.application\.name\s*[:=]\s*([\w.-]+)/.exec(text)?.[1] ?? /spring:\s*\n\s+application:\s*\n\s+name:\s*['"]?([\w.-]+)/.exec(text)?.[1];
        if (name && !repository.aliases.includes(name)) repository.aliases.push(name);
        files.push({ repository: owner, file: path.relative(owner, target), text, routes: extractRoutes(text, target) });
      }
    };
    const roots = [...(this.catalog.repositoryRoots ?? []), ...(this.catalog.services ?? []).map(s => s.repository).filter(Boolean)];
    const canonical = new Set();
    for (const input of roots) {
      try {
        const directory = await realpath(path.resolve(this.root, input));
        if (canonical.has(directory)) continue;
        canonical.add(directory);
        await walk(directory, null, 0);
      } catch (e) { signal?.throwIfAborted(); warnings.push(`代码目录索引不完整 ${input}：${e.code ?? e.message}`); }
    }
    this.snapshot = { builtAt: Date.now(), repositories: [...repositories.values()], files, warnings, truncated };
    return this.snapshot;
  }
}

export function endpointMatch(pattern, requested) {
  if (pattern === requested) return 'literal';
  const p = pattern.split('/').filter(Boolean), r = requested.split('/').filter(Boolean);
  if (p.length === r.length && p.every((v, i) => /^\{[^}]+\}$/.test(v) || v === '*' || v === r[i])) return 'path-template';
  return null;
}
