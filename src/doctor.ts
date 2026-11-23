import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { AncError, exists, privateMode, readJSON } from './common.js';
import { stateRoot, type Host } from './init.js';
import { loadOrg, readSecrets, secretName } from './org.js';
import { codexEnvironment, guardedArgs } from './codex-runner.js';
import { filesystemPolicy } from './render.js';
import { verifyCodexProtocol } from './compat.js';
import { orgRoot, memberHome, gatewayLabel } from './layout.js';
import { skillStatus } from './skills.js';

export interface Check { id: string; status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP' | 'UNKNOWN'; message: string; fix?: string }
export function locate(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const p = path.join(dir, command);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* continue */ }
  }
}
export function run(command: string, args: string[], timeout = 15000, environment: NodeJS.ProcessEnv = process.env) { return spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], env: codexEnvironment(environment) }); }
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
  const source = orgRoot(host);
  if (vault !== host.vaultRoot) checks.push({ id: 'binding', status: 'FAIL', message: '目标与主机绑定的 vault 不一致', fix: '使用 host.json 指定的 vault。' });
  check('org', () => { const org = loadOrg(source); if (org.id !== host!.companyId) throw Error(); return `${org.members.length} 个启用成员，org 结构通过`; }, '核对 company 和 members 定义。');
  if (checks.some(c=>c.id==='org' && c.status==='FAIL')) return { schemaVersion:1,status:'blocked',checks };
  check('bindings', () => { const org = loadOrg(source); if (org.missing.length) throw new AncError('MISSING_BINDINGS', `待填：${org.missing.join(', ')}`, '填写成员的飞书应用 ID 和本人 open_id。'); return '飞书绑定字段完整（尚未进行网络鉴权）'; }, '检查飞书绑定。');
  check('secrets', () => { const p = path.join(state, 'secrets.env'); privateMode(p, 0o600); const secrets = readSecrets(p); const missing = loadOrg(source).members.filter(m => !secrets[secretName(m.id)]); if (missing.length) throw new AncError('MISSING_SECRETS', `缺少 ${missing.map(m => secretName(m.id)).join(', ')}`, '在本机 secrets.env 填写，勿放到命令行或 Git。'); return 'secret 键齐全，权限为 600'; }, '核对本机 secrets.env。');
  check('skills', () => { if (skillStatus(opts.stateDir).status !== 'current') throw Error(); return '角色技能与部署副本一致'; }, '先运行 anc deploy skills 预览，再加 --apply。');
  const codex = host.codexPath ?? locate('codex'), gateway = host.gatewayPath ?? locate('cc-connect');
  check('codex', () => { if (!codex) throw Error(); const r = run(codex, ['--version']); if (r.status !== 0) throw Error(); return r.stdout.trim().split('\n')[0] ?? 'Codex 可执行'; }, '安装官方 Codex CLI 并加入 PATH。');
  if (codex) check('codex-permissions', () => { verifyCodexProtocol(codex); return '首次与 resume 协议支持命名权限'; }, '使用已验证支持命名权限的官方 Codex CLI。');
  if (codex) check('auth', () => { const r = run(codex, ['login', 'status']); if (r.status !== 0) throw Error(); return '官方 CLI 报告已登录（未进行模型调用）'; }, '在本机用户环境执行 codex login。');
  else checks.push({ id: 'auth', status: 'SKIP', message: '先安装 Codex CLI' });
  check('gateway', () => { if (!gateway) throw Error(); const r = run(gateway, ['--version']); if (r.status !== 0 || !r.stdout.split('\n')[0]?.endsWith(` ${host!.gatewayVersion}`)) throw Error(); return `gateway ${host!.gatewayVersion} 版本匹配`; }, '安装 host.json 指定版本的 cc-connect。');
  check('gui', () => { if (process.platform !== 'darwin' || run('launchctl', ['print', `gui/${process.getuid!()}`]).status !== 0) throw Error(); return '当前用户 GUI launchd 域存在'; }, '在 macOS 桌面登录此用户后运行；首版只支持 macOS。');
  if (gateway && process.platform==='darwin') check('gateway-processes',()=>{
    const processes=run('ps',['-u',String(process.getuid!()),'-o','pid=,ppid=,comm=']);if(processes.status!==0)throw Error();
    const rows=processes.stdout.split('\n').map(line=>/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter((r):r is RegExpExecArray=>!!r);
    const live=run('launchctl',['print',`gui/${process.getuid!()}/${gatewayLabel(host!)}`]),pid=/\bpid = (\d+)/.exec(live.stdout)?.[1];
    const owned=new Set(pid?[pid]:[]);for(let n=0;n<rows.length;n++)for(const r of rows)if(owned.has(r[2]!))owned.add(r[1]!);
    if(rows.some(r=>path.basename(r[3]!)===path.basename(gateway) && !owned.has(r[1]!)))throw Error();
    return '未发现脱离本服务的同用户网关进程';
  },'核对孤立网关的配置路径和归属，确认无业务任务后停止重复实例；不要盲目批量 kill。');
  check('git', () => { if (run('git', ['-C', vault, 'rev-parse', '--git-dir']).status !== 0) throw Error(); return 'vault Git 仓库存在'; }, '安装 Git 并在 vault 执行 git init。');
  const org = loadOrg(source), synced = !!org.syncEnabled;
  const working = run('git',['-C',vault,'status','--porcelain']);
  checks.push({id:'git-worktree',status:working.status!==0?'UNKNOWN':working.stdout.trim()?(synced?'FAIL':'WARN'):'PASS',message:working.stdout.trim()?'知识库有未提交修改；自动同步会保留修改并暂停':'知识库工作区干净',...(working.status!==0||working.stdout.trim()?{fix:'核对业务修改后自行提交；anc 不自动 stash、commit 或 reset。'}:{})});
  if (synced) {
    check('git-upstream',()=>{if(run('git',['-C',vault,'rev-parse','--abbrev-ref','@{upstream}']).status!==0)throw Error();const r=run('git',['-C',vault,'rev-list','--left-right','--count','HEAD...@{upstream}']);if(r.status!==0 || !/^0\s+\d+\s*$/.test(r.stdout))throw Error();return '本地可向已获取的上游快进';},'核对 origin 与 tracking branch，处理本地未发布提交或分叉后重试。');
    check('git-remote',()=>{if(run('git',['-C',vault,'-c','credential.interactive=false','ls-remote','--exit-code','origin','HEAD'],15000).status!==0)throw Error();return 'origin 可读（未修改 refs 或工作区）';},'配置当前用户的私有仓库 Git 凭据，并核对网络。');
  } else checks.push({id:'git-sync',status:'SKIP',message:'未启用远端同步，不安装定时 pull'});
  check('disk',()=>{const stats=fs.statfsSync(state);if(stats.bavail*stats.bsize<1024**3)throw Error();return '可用空间大于 1 GiB';},'清理磁盘空间后重试。');
  const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  checks.push({id:'timezone',status:zone===org.timezone?'PASS':'WARN',message:`系统时区 ${zone}；公司时区 ${org.timezone}`,...(zone===org.timezone?{}:{fix:'核对系统日期与时间设置；不自动改系统时区。'})});
  if (process.platform === 'darwin') {
    const plist=path.join(process.env.HOME ?? '', 'Library/LaunchAgents',gatewayLabel(host)+'.plist');
    if(exists(plist))check('launch-agent',()=>{const r=run('plutil',['-convert','json','-o','-',plist]);if(r.status!==0)throw Error();const p=JSON.parse(r.stdout);if(p.SessionCreate || p.Label!==gatewayLabel(host!) || !p.EnvironmentVariables?.PATH)throw Error();return '服务 label、PATH 与 GUI 凭据约束通过';},'核对服务 plist；不使用 SessionCreate，保留完整执行路径。');
    const power=run('pmset',['-g','custom']);
    checks.push({id:'sleep',status:power.status!==0?'UNKNOWN':/\bsleep\s+0\b/.test(power.stdout)?'PASS':'WARN',message:/\bsleep\s+0\b/.test(power.stdout)?'已配置机器不自动休眠':'尚未确认机器防休眠设置',fix:'在系统设置核对接通电源时不自动休眠；显示器可以休眠。'});
    const auto=run('defaults',['read','/Library/Preferences/com.apple.loginwindow','autoLoginUser']);
    checks.push({id:'auto-login',status:auto.status===0 && auto.stdout.trim()===osUser()?'PASS':'WARN',message:auto.status===0?'检测到自动登录设置，请核对所用账户':'重启后需要人工登录才能恢复 GUI 服务',fix:'按负责人选择保留人工登录或在系统设置启用自动登录；anc 不保存登录口令。'});
  }
  checks.push({id:'watchdog-recipient',status:host.operations?.alertMember?'PASS':'WARN',message:host.operations?.alertMember?'已配置明确的本人私聊告警收件成员':'尚未配置故障告警收件成员',...(!host.operations?.alertMember?{fix:'明确授权收件人后配置 host.operations.alertMember。'}:{})});
  if (!exists(path.join(state, 'deployment.json'))) checks.push({ id: 'deployment', status: 'WARN', message: '尚未部署；初始化成功不等于上线' });
  if (opts.probe && codex) {
    check('probe', () => {
      const member = loadOrg(source).members[0]!;
      const home = memberHome(host!, state, member);
      const args = guardedArgs(['exec', '--skip-git-repo-check', '--ephemeral', '-C', home, '部署认证探针：不使用工具、不修改文件、不发送消息，只回复 ANC_PROBE_OK。'], filesystemPolicy(vault, home, 'readonly'));
      const environment = { ...process.env };
      const runtime = path.join(state,'runtime.json');
      if(exists(runtime)) {
        const deployed = readJSON<{environment:Record<string,string>}>(runtime).environment;
        for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','CODEX_HOME'])if(typeof deployed?.[key]==='string')environment[key]=deployed[key];
      }
      const r = run(codex, args, 90000, environment);
      if (r.status !== 0 || !r.stdout.includes('ANC_PROBE_OK')) throw Error();
      return '官方 Codex 真实调用成功';
    }, '检查账号额度、网络和 CLI 状态；诊断时不要输出凭据。');
  }
  return { schemaVersion: 1, status: checks.some(c => c.status === 'FAIL' || c.status === 'UNKNOWN') ? 'blocked' : 'ready-to-deploy', checks };
}
function osUser(): string { return process.env.USER ?? ''; }
