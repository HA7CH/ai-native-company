import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class AncError extends Error {
  constructor(public code: string, message: string, public fix: string, public exitCode = 1) { super(message); }
}
export function fail(code: string, message: string, fix: string, exitCode = 1): never {
  throw new AncError(code, message, fix, exitCode);
}
export function sha(text: string | Buffer): string { return createHash('sha256').update(text).digest('hex'); }
export function exists(p: string): boolean { try { fs.lstatSync(p); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
export function readJSON<T>(p: string): T {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; }
  catch { return fail('INVALID_STATE', `无法读取状态文件：${p}`, '保留现场，从备份恢复状态；不要删除身份记录后覆盖初始化。'); }
}
// Reject symlinks in the owned portion, while resolving pre-existing ancestors of a new root.
export function canonicalRoot(input: string): string {
  const absolute = path.resolve(input);
  if (exists(absolute)) {
    if (fs.lstatSync(absolute).isSymbolicLink() || !fs.statSync(absolute).isDirectory()) fail('UNSAFE_PATH', `目标不是普通目录：${absolute}`, '选择真实目录，不能使用符号链接或文件。');
    return fs.realpathSync(absolute);
  }
  return path.join(canonicalRoot(path.dirname(absolute)), path.basename(absolute));
}
export function assertTree(root: string, relative: string, kind: 'file' | 'directory'): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) fail('UNSAFE_PATH', '拒绝越界路径', '使用受管目录内的相对路径。');
  let cursor = root;
  const parts = relative.split('/').filter(Boolean);
  for (const [i, part] of parts.entries()) {
    cursor = path.join(cursor, part);
    if (!exists(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    const directory = i < parts.length - 1 || kind === 'directory';
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail('PATH_CONFLICT', `路径类型冲突：${cursor}`, '移走冲突对象或选择另一个空目录。');
  }
  return cursor;
}
export function privateDir(p: string): void { fs.mkdirSync(p, { recursive: true, mode: 0o700 }); }
export function atomicWrite(p: string, content: string, replace = false): void {
  privateDir(path.dirname(p));
  const temp = path.join(path.dirname(p), `.anc-${randomUUID()}.tmp`);
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try {
    if (replace) fs.renameSync(temp, p);
    else fs.linkSync(temp, p); // Atomic no-clobber commit, unlike rename.
    const dir = fs.openSync(path.dirname(p), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { if (exists(temp)) fs.unlinkSync(temp); }
}
export function acquireLock(root: string): () => void {
  const p = path.join(root, '.anc.lock');
  const token = randomUUID();
  try { atomicWrite(p, JSON.stringify({ pid: process.pid, token })); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const lock = readJSON<{ pid: number }>(p);
    let dead = false;
    if (!Number.isInteger(lock.pid) || lock.pid <= 0) fail('INVALID_LOCK', '初始化锁损坏', '人工核实没有 anc 进程后移走锁文件。');
    try { process.kill(lock.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    // Do not auto-unlink: two contenders could otherwise unlink each other's replacement lock.
    fail('LOCKED', dead ? '上次进程已退出，但恢复锁仍存在' : '另一个 anc 进程正在操作此主机状态', dead ? `核实进程 ${lock.pid} 已退出后，移走 ${p}，再运行原命令；事务记录会续跑。` : '等待该进程结束。');
  }
  return () => { if (exists(p) && readJSON<{ token: string }>(p).token === token) fs.unlinkSync(p); };
}
export function privateMode(p: string, mode: number): void {
  if ((fs.statSync(p).mode & 0o777) !== mode) fail('INSECURE_MODE', `权限不符合要求：${p}`, `设置权限为 ${mode.toString(8)} 后重试。`);
}
export const json = (x: unknown): string => JSON.stringify(x, null, 2) + '\n';
