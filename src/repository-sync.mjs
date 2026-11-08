import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const skip = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.venv', 'venv', '__pycache__', '.local']);

async function git(directory, args, signal) {
  return (await execute('git', ['-C', directory, ...args], {
    signal, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes -o ConnectTimeout=8' },
  })).stdout.trim();
}

async function findRepositories(root, catalog, signal) {
  const repositories = new Set(), visited = new Set(), warnings = [];
  let count = 0;
  const walk = async (directory, depth) => {
    signal?.throwIfAborted();
    if (visited.has(directory)) return;
    visited.add(directory);
    if (++count > 10000 || depth > 25) throw new Error('代码根目录扫描超过上限，请缩小根目录范围');
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(e => e.name === '.git')) { repositories.add(directory); return; }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink() && !skip.has(e.name) && !e.name.startsWith('.')) await walk(path.join(directory, e.name), depth + 1);
  };
  for (const input of [...(catalog.repositoryRoots ?? []), ...(catalog.services ?? []).map(s => s.repository).filter(Boolean)]) {
    try {
      const directory = await realpath(path.resolve(root, input));
      // A root may point into a module of an existing checkout.
      try { repositories.add(await realpath(await git(directory, ['rev-parse', '--show-toplevel'], signal))); }
      catch { signal?.throwIfAborted(); await walk(directory, 0); }
    } catch (e) { signal?.throwIfAborted(); warnings.push({ root: input, status: 'failed', reason: e.code ?? e.message }); }
  }
  return { repositories: [...repositories].sort(), warnings };
}

export async function updateRepository(repository, signal) {
  let stage = '检查仓库';
  const blocked = reason => ({ repository, status: 'blocked', reason });
  try {
    const branch = await git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal);
    if (await git(repository, ['status', '--porcelain', '--untracked-files=normal'], signal)) return blocked('存在本地修改或未跟踪文件，未更新工作区');
    const remote = await git(repository, ['config', '--get', `branch.${branch}.remote`], signal);
    const ref = await git(repository, ['config', '--get', `branch.${branch}.merge`], signal);
    if (!remote || remote === '.' || !ref.startsWith('refs/heads/')) return blocked('当前分支没有可用的远端跟踪分支');
    const before = await git(repository, ['rev-parse', 'HEAD'], signal);
    stage = '拉取远端';
    await git(repository, ['fetch', '--no-tags', '--', remote, ref], signal);
    const target = await git(repository, ['rev-parse', 'FETCH_HEAD'], signal);
    const [ahead, behind] = (await git(repository, ['rev-list', '--left-right', '--count', `HEAD...${target}`], signal)).split(/\s+/).map(Number);
    if (ahead > 0) return { ...blocked(behind > 0 ? '本地与远端分支已分叉，未合并' : '当前分支有本地提交，未改写'), branch, before, remoteCommit: target };
    if (await git(repository, ['symbolic-ref', '--quiet', '--short', 'HEAD'], signal) !== branch || await git(repository, ['rev-parse', 'HEAD'], signal) !== before || await git(repository, ['status', '--porcelain', '--untracked-files=normal'], signal)) return blocked('同步过程中工作区或分支发生变化，已停止');
    stage = '快进更新';
    if (behind > 0) await git(repository, ['merge', '--ff-only', '--no-edit', target], signal);
    const commit = await git(repository, ['rev-parse', 'HEAD'], signal);
    if (commit !== target || await git(repository, ['status', '--porcelain', '--untracked-files=normal'], signal)) return blocked('更新后工作区发生变化，不能确认为最新干净代码');
    return { repository, branch, before, commit, status: behind > 0 ? 'updated' : 'up-to-date', checkedAt: new Date().toISOString(), versionVerified: false };
  } catch (e) {
    signal?.throwIfAborted();
    // Git errors may embed credential-bearing remote URLs; do not relay stderr.
    return { repository, status: 'failed', reason: `${stage}失败，请检查 Git 登录、网络及分支跟踪配置`, code: String(e.code ?? 'GIT_ERROR') };
  }
}

export async function syncRepositories(root, catalog, mode, signal) {
  if (mode === 'mock') return { mode: 'mock', ready: true, repositories: [], note: '模拟样例不是 Git 仓库，本轮未执行真实同步，不声称代码已更新。' };
  const discovered = await findRepositories(root, catalog, signal);
  const results = [];
  for (let i = 0; i < discovered.repositories.length; i += 4) results.push(...await Promise.all(discovered.repositories.slice(i, i + 4).map(repository => updateRepository(repository, signal))));
  return { mode: 'git', checkedAt: new Date().toISOString(), ready: results.length > 0 && !discovered.warnings.length && results.every(r => ['updated', 'up-to-date'].includes(r.status)), repositories: results, warnings: discovered.warnings, note: '最新指当前分支的远端跟踪分支；不代表服务器正在运行此 commit。不切分支、不 stash、不 reset、不 rebase。' };
}
