import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AncError, exists, privateMode, readJSON } from './common.js';
import { stateRoot, type Host } from './init.js';
import { loadOrg, readSecrets, secretName } from './org.js';
import { codexEnvironment, guardedArgs } from './codex-runner.js';
import { filesystemPolicy } from './render.js';
import { verifyCodexProtocol } from './compat.js';

export interface Check { id: string; status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'UNKNOWN'; message: string; fix?: string }
export function locate(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, command);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* continue */ }
  }
}
export function run(command: string, args: string[], timeout = 15000) { return spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: codexEnvironment(process.env) }); }
export function doctor(opts: { dir?: string; stateDir?: string; probe?: boolean }) {
  const state = stateRoot(opts.stateDir), checks: Check[] = [];
  let host: Host | undefined;
  const check = (id: string, fn: () => string, fix: string) => {
    try { checks.push({ id, status: 'PASS', message: fn() }); }
    catch (e) { checks.push({ id, status: 'FAIL', message: e instanceof AncError ? e.message : `${id} 检查未通过`, fix: e instanceof AncError ? e.fix : fix }); }
  };
  check('state', () => { privateMode(state, 0o700); host = readJSON<Host>(path.join(state, 'host.json')); if (host.schemaVersion !== 1 || host.harness !== 'codex') throw Error(); return '主机状态可读'; }, '先运行 anc init。');
  if (!host) return { schemaVersion: 1, status: 'blocked', checks };
  const vault = opts.dir ? path.resolve(opts.dir) : host.vaultRoot;
  if (vault !== host.vaultRoot) checks.push({ id: 'binding', status: 'FAIL', message: '目标与主机绑定的 vault 不一致', fix: '使用 host.json 指定的 vault。' });
  check('org', () => { const org = loadOrg(vault); if (org.id !== host!.companyId) throw Error(); return `${org.members.length} 个启用成员，org 结构通过`; }, '核对 company 和 members 定义。');
  check('bindings', () => { const org = loadOrg(vault); if (org.missing.length) throw new AncError('MISSING_BINDINGS', `待填：${org.missing.join(', ')}`, '填写成员的飞书应用 ID 和本人 open_id。'); return '飞书绑定字段完整（尚未进行网络鉴权）'; }, '检查飞书绑定。');
  check('secrets', () => { const p = path.join(state, 'secrets.env'); privateMode(p, 0o600); const secrets = readSecrets(p); const missing = loadOrg(vault).members.filter(m => !secrets[secretName(m.id)]); if (missing.length) throw new AncError('MISSING_SECRETS', `缺少 ${missing.map(m => secretName(m.id)).join(', ')}`, '在本机 secrets.env 填写，勿放到命令行或 Git。'); return 'secret 键齐全，权限为 600'; }, '核对本机 secrets.env。');
  const codex = host.codexPath ?? locate('codex'), gateway = host.gatewayPath ?? locate('cc-connect');
  check('codex', () => { if (!codex) throw Error(); const r = run(codex, ['--version']); if (r.status !== 0) throw Error(); return r.stdout.trim().split('\n')[0] ?? 'Codex 可执行'; }, '安装官方 Codex CLI 并加入 PATH。');
  if (codex) check('codex-permissions', () => { verifyCodexProtocol(codex); return '首次与 resume 协议支持命名权限'; }, '使用已验证支持命名权限的官方 Codex CLI。');
  if (codex) check('auth', () => { const r = run(codex, ['login', 'status']); if (r.status !== 0) throw Error(); return '官方 CLI 报告已登录（未进行模型调用）'; }, '在本机用户环境执行 codex login。');
  else checks.push({ id: 'auth', status: 'SKIP', message: '先安装 Codex CLI' });
  check('gateway', () => { if (!gateway) throw Error(); const r = run(gateway, ['--version']); if (r.status !== 0 || !r.stdout.split('\n')[0]?.endsWith(` ${host!.gatewayVersion}`)) throw Error(); return `gateway ${host!.gatewayVersion} 版本匹配`; }, '安装 host.json 指定版本的 cc-connect。');
  check('gui', () => { if (process.platform !== 'darwin' || run('launchctl', ['print', `gui/${process.getuid!()}`]).status !== 0) throw Error(); return '当前用户 GUI launchd 域存在'; }, '在 macOS 桌面登录此用户后运行；首版只支持 macOS。');
  check('git', () => { if (run('git', ['-C', vault, 'rev-parse', '--git-dir']).status !== 0) throw Error(); return 'vault Git 仓库存在'; }, '安装 Git 并在 vault 执行 git init。');
  if (!exists(path.join(state, 'deployment.json'))) checks.push({ id: 'deployment', status: 'WARN', message: '尚未部署；初始化成功不等于上线' });
  if (opts.probe && codex) {
    check('probe', () => {
      const member = loadOrg(vault).members[0]!;
      const home = path.join(state, 'homes', member.id);
      const args = guardedArgs(['exec', '--skip-git-repo-check', '--ephemeral', '-C', home, '部署认证探针：不使用工具、不修改文件、不发送消息，只回复 ANC_PROBE_OK。'], filesystemPolicy(vault, home, 'readonly'));
      const r = run(codex, args, 90000);
      if (r.status !== 0 || !r.stdout.includes('ANC_PROBE_OK')) throw Error();
      return '官方 Codex 真实调用成功';
    }, '检查账号额度、网络和 CLI 状态；诊断时不要输出凭据。');
  }
  return { schemaVersion: 1, status: checks.some(c => c.status === 'FAIL' || c.status === 'UNKNOWN') ? 'blocked' : 'ready-to-deploy', checks };
}
