import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractRoutes } from '../src/discovery.mjs';
import { QueryTools } from '../src/queries.mjs';
import catalog from '../fixtures/catalog.json' with { type: 'json' };
const root = path.resolve(import.meta.dirname, '..');

test('无 services/routes 配置，按接口跨仓找到 Spring 控制器与容器，再查询下游日志', async () => {
  assert.equal(catalog.services, undefined);
  const q = new QueryTools({ root, catalog, mode: 'mock' });
  const result = await q.findEndpoint({ environment: 'test', endpoint: 'https://example.invalid/api/orders?q=1', method: 'POST' });
  const found = result.matches.find(x => x.file === 'OrderController.java');
  assert.equal(found.path, '/api/orders'); assert.equal(found.line, 10);
  assert.equal(found.instances[0].service, 'order-service'); assert.equal(found.versionVerified, false);
  const stock = await q.findEndpoint({ environment: 'test', endpoint: '/internal/stock/reserve', method: 'POST' });
  assert.equal(stock.matches[0].instances[0].service, 'stock-service');
  assert.equal(stock.matches[0].line, 6);
  const logs = await q.logs({ environment: 'test', service: 'stock-service', since: '2026-11-09T01:59:00+08:00', until: '2026-11-09T02:01:00+08:00', traceId: 'demo-order-101' });
  assert.ok(logs.lines.some(l => l.text.includes('CACHE_NAMESPACE')));
});
test('Spring 合并类和方法的多路径/多 HTTP 方法；忽略注释和动态表达式', () => {
  const source = `// @GetMapping("/fake")
@RequestMapping(path={"/api", "/v2"})
class C {
@RequestMapping(value={"/orders", "/purchases"}, method={RequestMethod.GET, RequestMethod.POST})
public void create() {}
@GetMapping(BASE + "/dynamic")
public void dynamic() {}
}`;
  const routes = extractRoutes(source, 'C.java');
  assert.equal(routes.length, 8);
  assert.ok(routes.some(r => r.path === '/v2/purchases' && r.method === 'POST'));
  assert.ok(!routes.some(r => r.path.includes('fake') || r.path.includes('dynamic')));
});
test('多实例不任意挑选；明确 instanceId 后才执行 Docker 查询，且不跨环境发现', async () => {
  const calls = [];
  const q = new QueryTools({ root, catalog: { environments: ['test', 'prod'], repositoryRoots: [], hosts: [{ environment: 'test', host: 'qa-a' }, { environment: 'test', host: 'qa-b' }, { environment: 'prod', host: 'prod-a' }] }, mode: 'ssh', runCommand: async (cmd, args) => {
    calls.push({ cmd, args });
    if (args.at(-1).startsWith('docker ps')) return { stdout: JSON.stringify({ Names: 'orders-1', Image: 'registry/orders:v1', Labels: 'com.docker.compose.service=orders', State: 'running' }) };
    return { stdout: '{"Running":true}' };
  } });
  const result = await q.services({ environment: 'test' });
  assert.equal(result.services.length, 2); assert.ok(!calls.some(c => c.args.includes('prod-a')));
  await assert.rejects(q.status({ environment: 'test', service: 'orders' }), /多个实例/);
  const instanceId = result.services[0].instanceId;
  assert.ok((await q.status({ environment: 'test', service: 'orders', instanceId })).state.Running);
  assert.equal(calls.filter(c => c.args.at(-1).startsWith('docker ps')).length, 2);
  await q.services({ environment: 'test', refresh: true });
  assert.equal(calls.filter(c => c.args.at(-1).startsWith('docker ps')).length, 4);
});
test('主机部分失败时仍返回成功发现的数据，并明确警告', async () => {
  const q = new QueryTools({ root, catalog: { environments: ['test'], hosts: [{ environment: 'test', host: 'good' }, { environment: 'test', host: 'bad' }] }, mode: 'ssh', runCommand: async (_cmd, args) => {
    if (args.includes('bad')) throw new Error('connection refused');
    return { stdout: JSON.stringify({ Names: 'api', Image: 'demo/api:v1', Labels: '' }) };
  } });
  const result = await q.services({ environment: 'test' });
  assert.equal(result.services.length, 1); assert.ok(result.warnings.some(w => w.includes('bad')));
});
test('代码仓无法关联容器也能读取源码；缓存可刷新并发现新增路由；网关仅作为线索', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'endpoint-index-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = path.join(directory, 'unknown'); await mkdir(repo);
  await writeFile(path.join(repo, 'pom.xml'), '<project/>');
  const file = path.join(repo, 'Api.java');
  await writeFile(file, 'class A { @GetMapping("/things/{id}") void get() {} }');
  await writeFile(path.join(repo, 'application.yml'), 'predicates:\n  - Path=/external/things/**\nfilters:\n  - StripPrefix=1');
  const q = new QueryTools({ root: directory, catalog: { environments: ['test'], repositoryRoots: [directory] }, mode: 'mock' });
  const result = await q.findEndpoint({ environment: 'test', endpoint: '/things/123', method: 'GET' });
  assert.equal(result.matches[0].match, 'path-template'); assert.deepEqual(result.matches[0].instances, []);
  const read = await q.codeRead({ repository: result.matches[0].repository, file: 'Api.java' });
  assert.ok(read.lines[0].text.includes('GetMapping'));
  await assert.rejects(q.codeRead({ repository: '/not-a-configured-repo', file: 'Api.java' }), /不在已配置/);
  await writeFile(file, 'class A { @PostMapping("/new") void post() {} }');
  const updated = await q.findEndpoint({ endpoint: '/new', refresh: true });
  assert.equal(updated.matches.length, 1);
  const removed = await q.findEndpoint({ endpoint: '/things/123' }); assert.equal(removed.matches.length, 0);
  const gateway = await q.findEndpoint({ endpoint: '/external/things' });
  assert.equal(gateway.matches.length, 0); assert.ok(gateway.hints.some(h => h.file === 'application.yml'));
});

test('同名代码仓与重复接口保留全部候选，不把代码映射到任意一个服务', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ambiguous-index-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const team of ['team-a', 'team-b']) {
    const repo = path.join(directory, team, 'api'); await mkdir(repo, { recursive: true });
    await writeFile(path.join(repo, 'pom.xml'), '<project/>');
    await writeFile(path.join(repo, 'C.java'), 'class C { @GetMapping("/shared") void get() {} }');
  }
  const q = new QueryTools({ root: directory, catalog: { environments: ['test'], repositoryRoots: [directory], services: [{ id: 'api', environment: 'test', host: 'qa-api', container: 'api' }] }, mode: 'mock' });
  const inventory = await q.services({ environment: 'test' });
  assert.equal(inventory.services[0].repositoryAssociation, 'ambiguous');
  assert.equal(inventory.services[0].repositoryConfigured, false);
  const result = await q.findEndpoint({ environment: 'test', endpoint: '/shared', method: 'GET' });
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every(m => m.instances[0].association === 'ambiguous'));
  await assert.rejects(q.codeRead({ environment: 'test', service: 'api', file: 'C.java' }), /尚未配置/);
});
