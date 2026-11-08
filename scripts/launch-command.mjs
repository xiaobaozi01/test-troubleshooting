// Node cannot directly spawn a Windows .cmd shim with shell:false. PowerShell's
// call operator supports .cmd and .exe; literal quoting keeps paths/arguments data.
export function launchCommand(cli, args, platform = process.platform) {
  if (platform !== 'win32') return { command: cli, args };
  const literal = value => `'${String(value).replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference = 'Stop'; & ${[cli, ...args].map(literal).join(' ')}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }`;
  return { command: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}
