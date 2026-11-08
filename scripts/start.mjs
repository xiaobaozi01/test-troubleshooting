import { access, readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchCommand } from './launch-command.mjs';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
const bundled = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh';
let cli = process.env.DSH_CLI;
if (!cli) { try { await access(bundled); cli = bundled; } catch { cli = 'dsh'; } }
const profile = process.env.DSH_TROUBLESHOOT_PROFILE ?? 'troubleshooting';
if (!/^[a-zA-Z0-9_-]+$/.test(profile) || ['desktop', 'web', 'headless', 'sdk'].includes(profile)) throw new Error('请使用独立的排障 profile 名称');
const run = (args, opts = {}) => new Promise((resolve, reject) => {
  const invocation = launchCommand(cli, args);
  const p = spawn(invocation.command, invocation.args, { cwd: root, stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', ...opts });
  let output = '', error = '';
  p.stdout?.on('data', b => output += b); p.stderr?.on('data', b => error += b);
  p.on('error', reject); p.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`Harness 启动失败 (${code})：${error.slice(-1500)}`)));
});
const version = await run(['--version'], { capture: true });
if (!/^0\.2\./.test(version)) throw new Error(`当前 CLI ${version} 与已验证的 0.2.2-rc.1 接口不同。请通过 DSH_CLI 指向桌面版配套 CLI。`);
await mkdir(path.join(root, '.local'), { recursive: true });
try { await access(path.join(dshHome, 'profiles', profile, 'package.json')); }
catch { await run(['--profile', profile, '--from-default-profile', 'web', '--dump-default-config'], { capture: true }); }
// Reuse the source profile's model choice only. Credentials stay in Harness.
let model;
const sourceProfile = process.env.DSH_SOURCE_PROFILE ?? 'desktop';
try {
  const yaml = await readFile(path.join(dshHome, 'profiles', sourceProfile, 'cordis.patch.yml'), 'utf8');
  const entry = yaml.split(/(?=^- id:)/m).find(x => /^- id: agent-default-model\s*$/m.test(x));
  if (entry) {
    model = {};
    for (const key of ['provider', 'model', 'reasoningEffort']) {
      const value = new RegExp(`^    ${key}:\\s*([^\\r\\n#]+)`, 'm').exec(entry)?.[1]?.trim();
      if (value && !value.startsWith('!!')) model[key] = value.replace(/^['"]|['"]$/g, '');
    }
    if (!model.provider || !model.model) model = undefined;
  }
} catch (e) { if (e.code !== 'ENOENT') throw e; }
const configFile = process.env.TROUBLESHOOT_CONFIG ?? 'config/demo.json';
const runConfig = JSON.parse(await readFile(path.resolve(root, configFile), 'utf8'));
if (runConfig.mode === 'ssh' && !model) throw new Error('公司模式未能读取源 profile 的模型选择，请先接入并确认内网模型，避免回退到默认模型。');
let browserSkillDirectory, browserEntry;
if (runConfig.deploymentBackend?.enabled) {
  const entry = runConfig.deploymentBackend.pluginEntry;
  browserEntry = entry ? path.resolve(root, entry) : createRequire(path.join(dshHome, 'profiles', sourceProfile, 'package.json')).resolve('@wxg-prc-cpg/browser-skill-dsh-plugin');
  browserSkillDirectory = path.resolve(path.dirname(browserEntry), '..');
}
let bskPath = process.env.BSK_PATH ?? runConfig.deploymentBackend?.bskPath;
if (!bskPath) { try { const local = path.join(root, '.local/bin', process.platform === 'win32' ? 'bsk.exe' : 'bsk'); await access(local); bskPath = local; } catch { bskPath = 'bsk'; } }
const patches = [
  ...(model ? [{ id: 'agent-default-model', config: model }] : []),
  ...(browserEntry ? [{ insert: [{ id: 'troubleshooting-browserskill', name: browserEntry, config: { bskPath, lazyTools: false, maxSessions: 3, sessionStateDirectory: path.join(root, '.local/bsk-starts') } }] }] : []),
  { insert: [{ id: 'test-troubleshooting', name: path.join(root, 'src/plugin.mjs'), config: { root, configFile, hostMode: 'standalone', ...(runConfig.runtimeFile ? { runtimeFile: runConfig.runtimeFile } : {}), ...(browserSkillDirectory ? { browserSkillDirectory } : {}) } }] },
];
const overlay = path.join(root, '.local/harness.patch.json');
await writeFile(overlay, JSON.stringify(patches, null, 2), { mode: 0o600 });
console.log(`使用 Harness ${version}，独立 profile：${profile}${model ? `，模型：${model.provider}/${model.model}` : ''}`);
if (runConfig.mode === 'mock') console.log(`模拟群界面：${new URL(runConfig.chat.baseUrl).origin}（需启动对应模拟接口）`);
const invocation = launchCommand(cli, ['--profile', profile, '--patch', overlay, '--no-open', '--port', process.env.HARNESS_PORT ?? '4318']);
const child = spawn(invocation.command, invocation.args, { cwd: root, stdio: 'inherit' });
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
