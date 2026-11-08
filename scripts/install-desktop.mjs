import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { configureDesktop } from './desktop-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const options = { root, dshHome: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh') };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) options.configFile = args[++i];
  else if (args[i] === '--profile' && args[i + 1]) options.profile = args[++i];
  else if (args[i] === '--remove') options.remove = true;
  else if (args[i] === '--dry-run') options.dryRun = true;
  else throw new Error(`未知或不完整的参数：${args[i]}`);
}
const result = await configureDesktop(options);
console.log(JSON.stringify(result, null, 2));
if (!options.dryRun) console.log(options.remove ? '已移除本脚本管理的配置块。Harness 重新加载配置后停止排障插件。' : '已接入现有 Harness profile。配置重新加载后自动轮询；若未自动加载，重启 Harness。无需 npm start；配置文件或插件代码更新后需重新加载。');
