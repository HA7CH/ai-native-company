import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, assertTree, atomicWrite, canonicalRoot, exists, fail, json, privateDir, privateMode, readJSON, sha } from './common.js';
import { type Host, stateRoot } from './init.js';
import { loadOrg, readSecrets, secretName } from './org.js';
import { doctor, locate, run } from './doctor.js';
import { filesystemPolicy, inlineTable, persona, plist, renderConfig, shellQuote } from './render.js';
import type { Runtime } from './codex-runner.js';
import { verifyCodexProtocol } from './compat.js';
import type { Org } from './org.js';

interface Deployment { schemaVersion: 1; fingerprint: string; sourceFingerprint: string; projects: string[]; label: string; files: Record<string, string>; installedAt: string }
export interface DeploymentOptions { dir?: string; stateDir?: string; apply?: boolean; allowScale?: boolean }
export interface DeploySystem {
  launchAgentsDir: string; locate: typeof locate; run: typeof run; doctor: typeof doctor;
  sandboxProbe: typeof sandboxProbe; ready: typeof waitReady;
}
function managedPath(p: string, state: string, plistPath: string): boolean {
  if (p === plistPath) return true;
  if (!p.startsWith(state + path.sep)) return false;
  const rel = path.relative(state, p);
  return ['config.toml', 'runtime.json', 'bin/codex', 'deployment.json'].includes(rel) || /^homes\/[a-z][a-z0-9-]{0,31}\/(AGENTS\.md|\.anc-bot-root)$/.test(rel);
}
function validateDeployment(d: Deployment, state: string, label: string, plistPath: string): void {
  if (!d || d.schemaVersion !== 1 || d.label !== label || !d.files || Array.isArray(d.files) || !Array.isArray(d.projects) || !d.projects.length || d.projects.some(p => typeof p !== 'string') || typeof d.sourceFingerprint !== 'string') fail('INVALID_STATE', '部署记录不兼容', '先恢复正确部署记录。');
  for (const [p, hash] of Object.entries(d.files)) {
    if (!managedPath(p, state, plistPath) || p === path.join(state, 'deployment.json') || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_STATE', '部署记录包含非受管文件', '核对部署记录，不能接管任意本机文件。');
    assertTree(p === plistPath ? path.dirname(plistPath) : state, p === plistPath ? path.basename(p) : path.relative(state, p), 'file');
  }
}
function activeSecrets(org: Org, state: string): Record<string, string> {
  const secretFile = assertTree(state, 'secrets.env', 'file'); privateMode(secretFile, 0o600);
  const all = readSecrets(secretFile);
  return Object.fromEntries(org.members.map(m => [secretName(m.id), all[secretName(m.id)] ?? '']));
}
function sourceFingerprint(org: Org, secrets: Record<string, string>): string { return sha(json({ org, credentialDigest: sha(json(secrets)) })); }
function context(opts: DeploymentOptions, system: DeploySystem) {
  const state = stateRoot(opts.stateDir); privateMode(state, 0o700);
  const host = readJSON<Host>(assertTree(state, 'host.json', 'file'));
  if (host.schemaVersion !== 1 || host.harness !== 'codex') fail('INVALID_STATE', '主机配置不兼容', '先完成 anc init。');
  const vault = canonicalRoot(opts.dir ?? host.vaultRoot);
  if (vault !== host.vaultRoot) fail('HOST_ALREADY_BOUND', 'vault 与主机绑定不一致', '使用 host.json 绑定的目录。');
  const org = loadOrg(vault);
  if (org.id !== host.companyId) fail('IDENTITY_CONFLICT', '公司 ID 与主机状态不一致', '修正 org 身份，不要覆盖生产配置。');
  const secrets = activeSecrets(org, state);
  const missing = org.members.filter(m => !secrets[secretName(m.id)]);
  if (missing.length) fail('MISSING_SECRETS', `缺少 ${missing.map(m => secretName(m.id)).join(', ')}`, '在本机 secrets.env 填值；不要通过命令行传密钥。');
  const marker = assertTree(state, 'deployment.json', 'file');
  const old = exists(marker) ? readJSON<Deployment>(marker) : undefined;
  const label = `com.anc.${org.id}.gateway`;
  const plistPath = path.join(system.launchAgentsDir, `${label}.plist`);
  const projects = org.members.map(m => `${org.id}-${m.id}`);
  if (old) validateDeployment(old, state, label, plistPath);
  if (old && json(old.projects) !== json(projects) && !opts.allowScale) fail('SCALE_CHANGE', '启用项目数量或身份发生变化', '审阅变更后显式传 --allow-scale。');
  return { state, host, vault, org, old, marker, label, plistPath, projects, secrets };
}
export function planDeployment(opts: DeploymentOptions, system: DeploySystem = realSystem) {
  const c = context(opts, system);
  if (exists(path.join(c.state, 'pending-deployment.json'))) fail('INTERRUPTED_DEPLOYMENT', '上次部署未完成，先恢复事务', '运行 anc rollback，再重新预览。');
  const codex = c.host.codexPath ?? system.locate('codex'), gateway = c.host.gatewayPath ?? system.locate('cc-connect');
  if (!codex || !gateway) fail('MISSING_CLI', '未找到 Codex 或 cc-connect', '安装官方 CLI 和固定 gateway 版本后重试。');
  if (!path.isAbsolute(codex) || !path.isAbsolute(gateway)) fail('INVALID_EXECUTABLE_PATH', 'CLI 路径必须为绝对路径', '在 host.json 中填写明确的 codexPath/gatewayPath。');
  const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
  const environment: Record<string, string> = { CODEX_HOME: path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex')) };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    const value = process.env[key];
    if (!value) continue;
    if (key !== 'NO_PROXY') {
      const url = new URL(value);
      if (url.username || url.password) fail('PROXY_CREDENTIALS', '代理 URL 不得包含凭据', '使用无凭据的本机代理；不要把凭据写入运行配置。');
    }
    environment[key] = value;
  }
  const credentials = assertTree(c.state, `credentials/${sha(json(c.secrets))}.env`, 'file');
  if (exists(credentials)) {
    privateMode(credentials, 0o600);
    if (sha(json(readSecrets(credentials))) !== sha(json(c.secrets))) fail('CREDENTIAL_DRIFT', '凭据版本文件已被修改', '保留旧版本用于恢复；请在 secrets.env 中编辑新凭据。');
  }
  const runtime: Runtime = { codex, gateway, credentials, path: process.env.PATH ?? '/usr/bin:/bin', environment, members: c.org.members.map(m => ({ home: path.join(c.state, 'homes', m.id), filesystem: filesystemPolicy(c.vault, path.join(c.state, 'homes', m.id), m.policy) })) };
  const files: Record<string, string> = {
    [path.join(c.state, 'config.toml')]: renderConfig(c.org, c.state),
    [path.join(c.state, 'runtime.json')]: json(runtime),
    [path.join(c.state, 'bin/codex')]: `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} _codex ${shellQuote(c.state)} "$@"\n`,
    [c.plistPath]: plist(c.label, process.execPath, [cli, '_gateway', c.state], c.state),
  };
  for (const m of c.org.members) {
    files[path.join(c.state, 'homes', m.id, 'AGENTS.md')] = persona(c.org, m, c.vault);
    files[path.join(c.state, 'homes', m.id, '.anc-bot-root')] = '';
  }
  for (const p of new Set([...Object.keys(files), ...Object.keys(c.old?.files ?? {})])) {
    if (p.startsWith(c.state + path.sep)) assertTree(c.state, path.relative(c.state, p), 'file');
    else assertTree(system.launchAgentsDir, path.basename(p), 'file');
    if (c.old?.files[p] && !exists(p)) fail('MISSING_MANAGED_FILE', `旧部署缺少受管文件：${p}`, '先从已验证备份恢复文件，避免切换到无法回滚的状态。');
    if (exists(p)) {
      if (!c.old?.files[p]) fail('UNMANAGED_FILE', `拒绝接管非 anc 管理文件：${p}`, '已有部署先做影子迁移，不通过 init/deploy 自动覆盖。');
      if (sha(fs.readFileSync(p)) !== c.old.files[p]) fail('DEPLOYMENT_DRIFT', `生成文件已被手改：${p}`, '核对差异，将修改移回 org 后恢复受管文件。');
    }
  }
  const fingerprint = sha(json(files));
  const removed = Object.keys(c.old?.files ?? {}).filter(p => !(p in files));
  return { ...c, files, runtime, fingerprint, removed, changed: [...Object.entries(files).filter(([p, text]) => !exists(p) || sha(fs.readFileSync(p)) !== sha(text)).map(([p]) => p), ...removed] };
}
function readiness(pid: string, projects: string[]) {
  let active = false, connections = 0, blocked = false, pending = '';
  const ready = new Set<string>();
  // cc-connect v1.3.4 logs "platform ready" before the SDK websocket connects.
  // SDK v3.5.3 emits one connected/disconnected event per live connection.
  return {
    feed(text: string) {
      const lines = (pending + text).split('\n'); pending = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('anc:boot pid=')) { active = line === `anc:boot pid=${pid}`; connections = 0; blocked = false; ready.clear(); }
        if (!active) continue;
        if (line.includes('failed to get bot open_id')) blocked = true;
        if (/\bconnected to wss:\/\//.test(line)) connections++;
        if (/\bdisconnected to wss:\/\//.test(line)) connections = Math.max(0, connections - 1);
        for (const p of projects) if (line.includes(`"platform ready" project=${p} platform=feishu`)) ready.add(p);
      }
    },
    get ready() { return active && !blocked && connections >= projects.length && ready.size === projects.length; },
  };
}
export function readyForPid(text: string, pid: string, projects: string[]): boolean {
  const tracker = readiness(pid, projects); tracker.feed(text); return tracker.ready;
}
export function readyLogForPid(log: string, pid: string, projects: string[]): boolean {
  const tracker = readiness(pid, projects), fd = fs.openSync(log, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let count: number;
    // Stream the complete file: a healthy process's startup marker may be old.
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) tracker.feed(buffer.toString('utf8', 0, count));
    return tracker.ready;
  } finally { fs.closeSync(fd); }
}
export async function waitReady(label: string, log: string, _offset: number, projects: string[], timeout = 90000): Promise<void> {
  const target = `gui/${process.getuid!()}/${label}`;
  const end = Date.now() + timeout;
  let previousPid = '', stable = 0;
  while (Date.now() < end) {
    const status = run('launchctl', ['print', target], 3000);
    if (status.status !== 0 && !serviceAbsent(status, label)) fail('SERVICE_STATE_UNKNOWN', '无法读取 launchd 服务状态', '检查 GUI 域与权限；不把未知状态当作就绪。');
    const pid = /\bpid = (\d+)/.exec(status.stdout ?? '')?.[1] ?? '';
    if (status.status === 0 && /state = running/.test(status.stdout) && pid && pid === previousPid) stable++;
    else stable = 0;
    previousPid = pid;
    if (stable >= 2 && exists(log)) {
      if (readyLogForPid(log, pid, projects)) return;
    }
    await delay(1000);
  }
  fail('READINESS_TIMEOUT', '服务未在期限内稳定就绪', '检查本机 gateway.log；不要把 running 当作已经能回复。');
}
function serviceAbsent(r: ReturnType<typeof run>, label: string): boolean {
  return r.status === 113 && (r.stderr ?? '').includes(`Could not find service "${label}" in domain for user gui: ${process.getuid!()}`);
}
async function stop(label: string, system: DeploySystem) {
  const target = `gui/${process.getuid!()}/${label}`;
  system.run('launchctl', ['bootout', target]);
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = system.run('launchctl', ['print', target]);
    if (serviceAbsent(r, label)) return;
    if (r.status !== 0) fail('SERVICE_STATE_UNKNOWN', '无法确认 launchd 服务状态', '检查 GUI 域与权限；恢复记录已保留，不能把查询失败当作已卸载。');
    await delay(300);
  }
  fail('STOP_UNVERIFIED', '未能确认旧服务已卸载，恢复记录已保留', '核对 launchd 后运行 anc rollback；不要删除恢复记录。');
}
async function launch(label: string, plistPath: string, system: DeploySystem) {
  const target = `gui/${process.getuid!()}/${label}`;
  await stop(label, system);
  // bootout can return before launchd finishes removing the old registration.
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = system.run('launchctl', ['print', target]);
    if (serviceAbsent(state, label) && system.run('launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistPath]).status === 0) return;
    if (state.status !== 0 && !serviceAbsent(state, label)) fail('SERVICE_STATE_UNKNOWN', '无法确认 launchd 服务状态', '检查 GUI 域和权限后恢复事务。');
    await delay(300);
  }
  fail('BOOTSTRAP_FAILED', 'launchd 装载失败', '检查当前用户 GUI 会话及 plist。');
}
export function sandboxProbe(codex: string, roots: string[] = []): void {
  verifyCodexProtocol(codex);
  const scratch = ['/tmp', '/private/tmp', os.tmpdir()].map(p => fs.realpathSync(p));
  if (roots.some(root => scratch.some(p => root === p || root.startsWith(p + path.sep)))) fail('UNSAFE_RUNTIME_ROOT', '真实部署目录不能放在系统临时区', 'Codex 会授予系统 scratch 目录基础访问；使用用户目录下的 vault 和状态目录。');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-permission-'));
  try {
    const readable = path.join(root, 'readable'), forbidden = path.join(root, 'private'); privateDir(readable); privateDir(forbidden);
    fs.writeFileSync(path.join(readable, 'fact'), 'allowed'); fs.writeFileSync(path.join(forbidden, 'sentinel'), 'private');
    const policy = inlineTable({ ':root': 'deny', ':minimal': 'read', [readable]: 'read' });
    const code = 'test -r "$1/fact" && ! test -r "$2/sentinel" && ! (printf changed > "$1/write-test")';
    const r = run(codex, ['sandbox', '-P', 'anc', '-c', `permissions.anc.filesystem=${policy}`, '--', '/bin/sh', '-c', code, 'probe', readable, forbidden]);
    if (r.status !== 0 || exists(path.join(readable, 'write-test'))) fail('SANDBOX_UNVERIFIED', '当前 Codex 未通过只读范围测试', '使用支持 named permissions 的官方 CLI；不得降级为全盘访问。');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
export async function deploy(opts: DeploymentOptions, system: DeploySystem = realSystem) {
  const plan = planDeployment(opts, system);
  if (!opts.apply) return { schemaVersion: 1, status: 'planned', changed: plan.changed, projects: plan.projects, config: plan.files[path.join(plan.state, 'config.toml')] };
  const checks = system.doctor(opts);
  if (checks.status === 'blocked') fail('DOCTOR_FAILED', '环境诊断未通过', '先运行 anc doctor 并解决 FAIL。');
  system.sandboxProbe(plan.runtime.codex, [plan.state, plan.vault]);
  const existing = path.join(os.homedir(), '.cc-connect/config.toml');
  if (exists(existing) && plan.org.members.some(m => fs.readFileSync(existing, 'utf8').includes(m.appId))) fail('EXISTING_BINDING', '应用已出现在另一份网关配置中', '走显式迁移流程，不能启动第二个网关抢连接。');
  const release = acquireLock(plan.state);
  try {
    const current = planDeployment(opts, system);
    if (current.fingerprint !== plan.fingerprint) fail('INPUT_CHANGED', '部署输入在预检期间变化', '重新预览并执行。');
    const live = system.run('launchctl', ['print', `gui/${process.getuid!()}/${plan.label}`]);
    if (live.status !== 0 && !serviceAbsent(live, plan.label)) fail('SERVICE_STATE_UNKNOWN', '无法确认现有服务状态', '检查 launchd GUI 域与访问权限后重试。');
    if (!plan.old && live.status === 0) fail('UNMANAGED_SERVICE', '同名 launchd 服务已存在但不归本部署管理', '先核对现有服务，不能自动 bootout 接管。');
    if (!plan.changed.length && plan.old && live.status === 0 && /state = running/.test(live.stdout)) {
      try {
        await system.ready(plan.label, path.join(plan.state, 'logs/gateway.log'), 0, plan.projects, 5000);
        const updated = { ...plan.old, sourceFingerprint: sourceFingerprint(plan.org, plan.secrets) };
        if (updated.sourceFingerprint !== plan.old.sourceFingerprint) atomicWrite(plan.marker, json(updated), true);
        return { schemaVersion: 1, status: 'unchanged', projects: plan.projects };
      } catch { /* The managed service needs repair; continue through the transaction. */ }
    }
    if (plan.old && live.status === 0) {
      const pid = /\bpid = (\d+)/.exec(live.stdout)?.[1];
      if (pid) {
        const ps = system.run('ps', ['-axo', 'pid=,ppid=,comm=']);
        if (ps.status !== 0) fail('UNKNOWN_ACTIVITY', '无法核实是否存在活动任务', '稍后重试；不打断未知运行状态的 bot。');
        const rows = ps.stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+/.exec(line)).filter(Boolean);
        const children = rows.filter(r => r![2] === pid).map(r => r![1]);
        if (rows.some(r => children.includes(r![2]))) fail('BUSY', '网关仍有活动子任务', '等待任务完成后再部署。');
      }
    }
    const log = path.join(plan.state, 'logs/gateway.log');
    const backup = path.join(plan.state, 'backups', `${Date.now()}.json`);
    const before: Record<string, string | null> = {};
    for (const p of [...Object.keys(plan.files), ...plan.removed, plan.marker]) before[p] = exists(p) ? fs.readFileSync(p, 'utf8') : null;
    atomicWrite(backup, json({ schemaVersion: 1, label: plan.label, files: before }));
    const journal = path.join(plan.state, 'pending-deployment.json');
    atomicWrite(journal, json({ backup }));
    privateDir(path.join(plan.state, 'data')); privateDir(path.join(plan.state, 'logs'));
    try {
      if (!exists(plan.runtime.credentials)) atomicWrite(plan.runtime.credentials, Object.entries(plan.secrets).map(([k, v]) => `${k}=${JSON.stringify(v)}\n`).join(''));
      const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-plist-'));
      try {
        const candidate = path.join(staging, 'candidate.plist'); atomicWrite(candidate, plan.files[plan.plistPath]!);
        if (system.run('plutil', ['-lint', candidate]).status !== 0) fail('INVALID_PLIST', '生成 plist 未通过检查', '保留诊断并修复模板。');
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
      // Stop before mutating any file an old gateway or adapter can still read.
      await stop(plan.label, system);
      for (const [p, content] of Object.entries(plan.files)) atomicWrite(p, content, exists(p));
      for (const p of plan.removed) if (exists(p)) fs.unlinkSync(p);
      fs.chmodSync(path.join(plan.state, 'bin/codex'), 0o700);
      const offset = exists(log) ? fs.statSync(log).size : 0;
      await launch(plan.label, plan.plistPath, system);
      await system.ready(plan.label, log, offset, plan.projects);
      const deployment: Deployment = { schemaVersion: 1, fingerprint: plan.fingerprint, sourceFingerprint: sourceFingerprint(plan.org, plan.secrets), projects: plan.projects, label: plan.label, files: Object.fromEntries(Object.entries(plan.files).map(([p, text]) => [p, sha(text)])), installedAt: new Date().toISOString() };
      atomicWrite(plan.marker, json(deployment), exists(plan.marker));
      fs.unlinkSync(journal);
      return { schemaVersion: 1, status: 'deployed', projects: plan.projects, verification: 'websocket-connected; real-message-test-pending', backup };
    } catch (e) {
      await stop(plan.label, system);
      for (const [p, content] of Object.entries(before)) {
        if (content === null) { if (exists(p)) fs.unlinkSync(p); }
        else atomicWrite(p, content, exists(p));
      }
      if (plan.old) {
        fs.chmodSync(path.join(plan.state, 'bin/codex'), 0o700);
        const offset = exists(log) ? fs.statSync(log).size : 0;
        await launch(plan.label, plan.plistPath, system); await system.ready(plan.label, log, offset, plan.old.projects);
        fs.unlinkSync(journal);
        fail('ROLLED_BACK', '新部署失败，旧版已恢复并重新就绪', '检查日志和 org；修复后重新预览。', 3);
      }
      fs.unlinkSync(journal);
      throw e;
    }
  } finally { release(); }
}
export async function rollback(opts: DeploymentOptions, system: DeploySystem = realSystem) {
  const state = stateRoot(opts.stateDir); privateMode(state, 0o700);
  const host = readJSON<Host>(assertTree(state, 'host.json', 'file'));
  if (host.schemaVersion !== 1 || !/^[a-z][a-z0-9-]{0,31}$/.test(host.companyId)) fail('INVALID_STATE', '主机身份记录不兼容', '恢复正确主机记录后再操作服务。');
  const label = `com.anc.${host.companyId}.gateway`, plistPath = path.join(system.launchAgentsDir, `${label}.plist`);
  const journal = assertTree(state, 'pending-deployment.json', 'file');
  const backups = assertTree(state, 'backups', 'directory');
  const release = acquireLock(state);
  try {
  const candidate = exists(journal) ? readJSON<{ backup: string }>(journal).backup : path.join(backups, fs.readdirSync(backups).filter(x => /^\d+\.json$/.test(x)).sort().at(-1) ?? 'none');
  if (typeof candidate !== 'string' || path.dirname(candidate) !== backups || !/^\d+\.json$/.test(path.basename(candidate)) || !exists(candidate)) fail('NO_BACKUP', '没有可恢复的部署备份', '检查 backups 和 pending-deployment.json。');
  assertTree(backups, path.basename(candidate), 'file');
  const record = readJSON<{ schemaVersion: number; label: string; files: Record<string, string | null> }>(candidate);
  if (record.schemaVersion !== 1 || record.label !== label || !record.files || Array.isArray(record.files) || !Object.hasOwn(record.files, path.join(state, 'deployment.json'))) fail('INVALID_BACKUP', '备份归属不匹配', '选择本公司的部署备份。');
  for (const [p, text] of Object.entries(record.files)) {
    if (!managedPath(p, state, plistPath) || (text !== null && typeof text !== 'string')) fail('INVALID_BACKUP', '备份中有非受管路径或非法内容', '人工核对备份，不执行恢复。');
    assertTree(p === plistPath ? system.launchAgentsDir : state, p === plistPath ? path.basename(p) : path.relative(state, p), 'file');
  }
    const previous = record.files[path.join(state, 'deployment.json')];
    if (previous) validateDeployment(JSON.parse(previous), state, label, plistPath);
    await stop(label, system);
    for (const [p, text] of Object.entries(record.files)) {
      if (text === null) { if (exists(p)) fs.unlinkSync(p); }
      else atomicWrite(p, text, exists(p));
    }
    const marker = path.join(state, 'deployment.json');
    if (exists(marker)) {
      fs.chmodSync(path.join(state, 'bin/codex'), 0o700);
      const log = path.join(state, 'logs/gateway.log'), offset = exists(log) ? fs.statSync(log).size : 0;
      await launch(label, plistPath, system);
      await system.ready(label, log, offset, readJSON<Deployment>(marker).projects);
    }
    if (exists(journal)) fs.unlinkSync(journal);
    return { schemaVersion: 1, status: exists(marker) ? 'restored' : 'not-deployed', backup: candidate };
  } finally { release(); }
}
export function gateway(state: string) {
  privateMode(state, 0o700);
  const runtime = readJSON<Runtime>(path.join(state, 'runtime.json'));
  if (path.dirname(runtime.credentials) !== path.join(state, 'credentials') || !/^[a-f0-9]{64}\.env$/.test(path.basename(runtime.credentials))) fail('INVALID_STATE', '运行凭据版本路径不合法', '重新核对部署状态。');
  assertTree(state, path.relative(state, runtime.credentials), 'file'); privateMode(runtime.credentials, 0o600);
  const secrets = readSecrets(runtime.credentials);
  if (sha(json(secrets)) + '.env' !== path.basename(runtime.credentials)) fail('CREDENTIAL_DRIFT', '运行凭据版本被修改', '恢复原凭据版本，或通过 secrets.env 重新部署。');
  process.stdout.write(`anc:boot pid=${process.pid}\n`);
  const child = spawn(runtime.gateway, ['--config', path.join(state, 'config.toml')], { stdio: 'inherit', cwd: state, env: { ...process.env, ...runtime.environment, ...secrets, PATH: `${path.join(state, 'bin')}:${runtime.path}` } });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', () => { process.stderr.write('anc: gateway could not start\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
export function status(opts: DeploymentOptions, system: DeploySystem = realSystem) {
  const state = stateRoot(opts.stateDir), marker = path.join(state, 'deployment.json');
  if (exists(path.join(state, 'pending-deployment.json'))) return { schemaVersion: 1, status: 'recovery-required' };
  if (!exists(marker)) return { schemaVersion: 1, status: 'not-deployed' };
  const d = readJSON<Deployment>(marker);
  const host = readJSON<Host>(assertTree(state, 'host.json', 'file'));
  const label = `com.anc.${host.companyId}.gateway`;
  validateDeployment(d, state, label, path.join(system.launchAgentsDir, `${label}.plist`));
  const drift = Object.entries(d.files).filter(([p, hash]) => !exists(p) || sha(fs.readFileSync(p)) !== hash).map(([p]) => p);
  let sourceChanged = false;
  try { const org = loadOrg(host.vaultRoot); sourceChanged = sourceFingerprint(org, activeSecrets(org, state)) !== d.sourceFingerprint; } catch { sourceChanged = true; }
  const r = system.run('launchctl', ['print', `gui/${process.getuid!()}/${d.label}`]);
  const running = r.status === 0 && /state = running/.test(r.stdout);
  const unknown = r.status !== 0 && !serviceAbsent(r, d.label);
  return { schemaVersion: 1, status: drift.length || sourceChanged ? 'drift' : unknown ? 'unknown' : running ? 'running' : 'stopped', drift, sourceChanged, projects: d.projects, verification: 'process-only; use a real Feishu message to verify replies' };
}
const realSystem: DeploySystem = { launchAgentsDir: path.join(os.homedir(), 'Library/LaunchAgents'), locate, run, doctor, sandboxProbe, ready: waitReady };
