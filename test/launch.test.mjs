import test from 'node:test';
import assert from 'node:assert/strict';
import { launchCommand } from '../scripts/launch-command.mjs';

test('macOS/Linux 直接启动配套 CLI，保留参数边界', () => {
  const args = ['--patch', '/path with spaces/patch.json'];
  assert.deepEqual(launchCommand('/path/dsh', args, 'darwin'), { command: '/path/dsh', args });
});
test('Windows 通过编码的 PowerShell 调用 cmd shim，路径中的特殊字符保持字面量', () => {
  const cli = "C:\\Users\\O'Brien\\DeepSeek Harness\\dsh.cmd";
  const result = launchCommand(cli, ['--patch', "C:\\work & data\\$env:PATH;note'1.json"], 'win32');
  assert.equal(result.command, 'powershell.exe');
  assert.ok(!result.args.includes('-ExecutionPolicy'));
  const decoded = Buffer.from(result.args.at(-1), 'base64').toString('utf16le');
  assert.ok(decoded.includes("& 'C:\\Users\\O''Brien\\DeepSeek Harness\\dsh.cmd'"));
  assert.ok(decoded.includes("'C:\\work & data\\$env:PATH;note''1.json'"));
});
