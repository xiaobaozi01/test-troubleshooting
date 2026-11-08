import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';

export class Store {
  constructor(file) { this.file = file; this.data = { version: 1, cursor: null, seen: {}, tasks: {}, outbox: [] }; this.writes = Promise.resolve(); }
  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (this.data.version !== 1) throw new Error('不支持的本地状态版本');
    return this;
  }
  async lock() {
    const file = `${this.file}.lock`;
    try { this.lockHandle = await open(file, 'wx', 0o600); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('状态锁无效，请确认没有正在运行的实例后移除锁文件');
      try { process.kill(pid, 0); throw new Error(`已有排障实例运行：PID ${pid}`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      await unlink(file);
      this.lockHandle = await open(file, 'wx', 0o600);
    }
    await this.lockHandle.writeFile(String(process.pid));
  }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2);
    const writing = this.writes.then(async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    });
    // Future saves may recover after a transient filesystem error, but this caller sees it.
    this.writes = writing.catch(() => {});
    return writing;
  }
  async close() {
    await this.writes;
    if (this.lockHandle) { await this.lockHandle.close(); await unlink(`${this.file}.lock`); this.lockHandle = null; }
  }
}
