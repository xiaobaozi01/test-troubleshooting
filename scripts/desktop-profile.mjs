import { readFile, writeFile, mkdir, rename, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const begin = '# BEGIN test-troubleshooting managed plugin';
const end = '# END test-troubleshooting managed plugin';

export function updateDesktopPatch(current, entries = []) {
  const lines = current.split(/\r?\n/);
  const first = lines.indexOf(begin), last = lines.indexOf(end);
  if ((first < 0) !== (last < 0) || last < first || lines.filter(l => l === begin).length > 1 || lines.filter(l => l === end).length > 1) throw new Error('排障插件配置标记不完整，请先检查 profile 文件');
  if (first >= 0) lines.splice(first, last - first + 1);
  let base = first >= 0 ? lines.join('\n').trimEnd() : current.trimEnd();
  if (!entries.length) return first < 0 ? current : base + '\n';
  if (/\bid:\s*['"]?test-troubleshooting\b|"id"\s*:\s*"test-troubleshooting"/m.test(base)) throw new Error('profile 已有未受本脚本管理的排障插件，请先合并该条配置，避免双重轮询');
  // An empty YAML sequence cannot be followed by block-sequence entries.
  base = base.replace(/^\[\]\s*(?:#.*)?$/m, '').trimEnd();
  return `${base}${base ? '\n\n' : ''}${begin}\n${entries.map(entry => '- ' + JSON.stringify(entry)).join('\n')}\n${end}\n`;
}

export async function configureDesktop({ root, dshHome, profile = 'desktop', configFile = 'config/demo.json', remove = false, dryRun = false }) {
  if (!/^[a-zA-Z0-9_-]+$/.test(profile)) throw new Error('profile 名称无效');
  const directory = path.join(dshHome, 'profiles', profile);
  const packageFile = path.join(directory, 'package.json');
  const profilePackage = JSON.parse(await readFile(packageFile, 'utf8'));
  if (!Array.isArray(profilePackage.dsh?.profile?.bundles)) throw new Error('目标不是可识别的 Harness profile，请检查 DSH_HOME 和 profile');
  const patchFile = path.join(directory, 'cordis.patch.yml');
  let current = '';
  try { current = await readFile(patchFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const entries = [];
  if (!remove) {
    const absoluteConfig = path.resolve(root, configFile);
    const config = JSON.parse(await readFile(absoluteConfig, 'utf8'));
    if (!['mock', 'ssh'].includes(config.mode)) throw new Error('排障配置 mode 无效');
    let browserSkillDirectory;
    if (config.deploymentBackend?.enabled) {
      // Reuse the user's existing BrowserSkill bundle, never mount a second copy.
      if (!profilePackage.dsh.profile.bundles.includes('@wxg-prc-cpg/browser-skill-dsh-plugin')) throw new Error('请先在此 Harness profile 中启用已安装的 BrowserSkill 插件');
      const entry = createRequire(packageFile).resolve('@wxg-prc-cpg/browser-skill-dsh-plugin');
      browserSkillDirectory = path.resolve(path.dirname(entry), '..');
      const browserConfig = { lazyTools: false };
      if (config.deploymentBackend.bskPath) browserConfig.bskPath = config.deploymentBackend.bskPath;
      else if (process.env.BSK_PATH) browserConfig.bskPath = process.env.BSK_PATH;
      else {
        const local = path.join(root, '.local', 'bin', process.platform === 'win32' ? 'bsk.exe' : 'bsk');
        try { await access(local); browserConfig.bskPath = local; } catch { /* Keep native settings when no project CLI exists. */ }
      }
      // Otherwise keep the existing native plugin's CLI path/settings.
      entries.push({ id: 'browserskill', config: browserConfig });
    }
    entries.push({ insert: [{ id: 'test-troubleshooting', name: path.join(root, 'src/desktop-plugin.mjs'), config: { root, configFile: absoluteConfig, hostMode: 'desktop', ...(browserSkillDirectory ? { browserSkillDirectory } : {}) } }] });
  }
  const next = updateDesktopPatch(current, entries);
  const changed = next !== current;
  let backup;
  if (changed && !dryRun) {
    backup = `${patchFile}.backup-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await writeFile(backup, current, { mode: 0o600, flag: 'wx' });
    let latest = '';
    try { latest = await readFile(patchFile, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (latest !== current) throw new Error('Harness 配置在安装时已变化，请重试；未覆盖新配置');
    const temporary = `${patchFile}.tmp-${randomUUID()}`;
    await writeFile(temporary, next, { mode: 0o600 });
    await rename(temporary, patchFile);
    await mkdir(path.join(root, '.local'), { recursive: true });
    await writeFile(path.join(root, '.local/desktop-install.json'), JSON.stringify({ profile, patchFile, backup, removed: remove, configFile: remove ? null : path.resolve(root, configFile), at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  }
  return { profile, patchFile, configFile: remove ? null : path.resolve(root, configFile), changed, dryRun, removed: remove, backup: backup ?? null };
}
