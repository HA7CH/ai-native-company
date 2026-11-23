import { serviceAbsent, stop, launch } from './launchd.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLock, assertTree, atomicWrite, canonicalRoot, canonicalTarget, exists, fail, isWithin, json, privateDir, privateMode, readJSON, sha } from './common.js';
import { type Host, stateRoot } from './init.js';
import { loadOrg, readSecrets, secretName } from './org.js';
import { doctor, locate, run } from './doctor.js';
import { filesystemPolicy, inlineTable, persona, plist, renderConfig, shellQuote } from './render.js';
import type { Runtime } from './codex-runner.js';
import { verifyCodexProtocol } from './compat.js';
import type { Org } from './org.js';
import { gatewayLabel, memberHome, orgRoot, projectName, validateMemberHomes } from './layout.js';
import { migration, type Migration } from './adopt.js';

interface Deployment { schemaVersion: 1; fingerprint: string; sourceFingerprint: string; projects: string[]; label: string; files: Record<string, string>; installedAt: string }
export interface DeploymentOptions { dir?: string; stateDir?: string; apply?: boolean; allowScale?: boolean; adopt?: boolean; view?: 'config' | 'personas' }
export interface DeploySystem {
  launchAgentsDir: string; locate: typeof locate; run: typeof run; doctor: typeof doctor;
  sandboxProbe: typeof sandboxProbe; ready: typeof waitReady;
  legacyReady?: typeof waitLegacyReady;
}
function managedPath(p: string, state: string, plistPath: string, host?: Host): boolean {
  if (p === plistPath) return true;
  if (Object.values(host?.layout?.members ?? {}).some(m => p === path.join(m.home, 'AGENTS.md') || p === path.join(m.home, '.anc-bot-root'))) return true;
  if (!p.startsWith(state + path.sep)) return false;
  const rel = path.relative(state, p);
  return ['config.toml', 'runtime.json', 'bin/codex', 'deployment.json'].includes(rel) || /^homes\/[a-z][a-z0-9-]{0,31}\/(AGENTS\.md|\.anc-bot-root)$/.test(rel);
}
function assertTarget(p: string, state: string, plistPath: string, host: Host): void {
  if (p.startsWith(state + path.sep)) { assertTree(state, path.relative(state, p), 'file'); return; }
  if (p === plistPath) { assertTree(path.dirname(p), path.basename(p), 'file'); return; }
  const member = Object.values(host.layout?.members ?? {}).find(m => p === path.join(m.home, 'AGENTS.md') || p === path.join(m.home, '.anc-bot-root'));
  if (!member) fail('INVALID_STATE', '生成路径不属于受管部署', '核对成员工作目录和服务记录。');
  assertTree(member.home, path.relative(member.home, p), 'file');
}
function validateDeployment(d: Deployment, state: string, label: string, plistPath: string, host: Host): void {
  if (!d || d.schemaVersion !== 1 || d.label !== label || !d.files || Array.isArray(d.files) || !Array.isArray(d.projects) || !d.projects.length || d.projects.some(p => typeof p !== 'string') || typeof d.sourceFingerprint !== 'string') fail('INVALID_STATE', '部署记录不兼容', '先恢复正确部署记录。');
  for (const [p, hash] of Object.entries(d.files)) {
    if (!managedPath(p, state, plistPath, host) || p === path.join(state, 'deployment.json') || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) fail('INVALID_STATE', '部署记录包含非受管文件', '核对部署记录，不能接管任意本机文件。');
    assertTarget(p, state, plistPath, host);
  }
}
function activeSecrets(org: Org, state: string): Record<string, string> {
  const secretFile = assertTree(state, 'secrets.env', 'file'); privateMode(secretFile, 0o600);
  const all = readSecrets(secretFile);
  return Object.fromEntries(org.members.map(m => [secretName(m.id), all[secretName(m.id)] ?? '']));
}
function sourceFingerprint(org: Org, secrets: Record<string, string>, host: Host): string { return sha(json({ org, host, credentialDigest: sha(json(secrets)) })); }
function context(opts: DeploymentOptions, system: DeploySystem) {
  const state = stateRoot(opts.stateDir); privateMode(state, 0o700);
  const host = readJSON<Host>(assertTree(state, 'host.json', 'file'));
  if (host.schemaVersion !== 1 || host.harness !== 'codex') fail('INVALID_STATE', '主机配置不兼容', '先完成 anc init。');
  const vault = canonicalRoot(opts.dir ?? host.vaultRoot);
  if (vault !== host.vaultRoot) fail('HOST_ALREADY_BOUND', 'vault 与主机绑定不一致', '使用 host.json 绑定的目录。');
  const org = loadOrg(orgRoot(host));
  if (org.id !== host.companyId) fail('IDENTITY_CONFLICT', '公司 ID 与主机状态不一致', '修正 org 身份，不要覆盖生产配置。');
  const secrets = activeSecrets(org, state);
  const missing = org.members.filter(m => !secrets[secretName(m.id)]);
  if (missing.length) fail('MISSING_SECRETS', `缺少 ${missing.map(m => secretName(m.id)).join(', ')}`, '在本机 secrets.env 填值；不要通过命令行传密钥。');
  const marker = assertTree(state, 'deployment.json', 'file');
  const old = exists(marker) ? readJSON<Deployment>(marker) : undefined;
  const label = gatewayLabel(host);
  const plistPath = path.join(system.launchAgentsDir, `${label}.plist`);
  const legacy = migration(state, host, plistPath);
  if (legacy && !old && !opts.adopt) fail('ADOPTION_REQUIRED', '首次切换需要显式接管', '核对预览后传 --adopt；准备接管不会停止旧服务。');
  const projects = org.members.map(m => projectName(host, org.id, m));
  if (new Set(projects).size !== projects.length || new Set(org.members.map(m => memberHome(host, state, m))).size !== projects.length) fail('INVALID_LAYOUT', '项目名或工作目录重复', '每人一个独立项目和 cwd。');
  validateMemberHomes(host,state,org.members);
  if (old) validateDeployment(old, state, label, plistPath, host);
  if (old && json(old.projects) !== json(projects) && !opts.allowScale) fail('SCALE_CHANGE', '启用项目数量或身份发生变化', '审阅变更后显式传 --allow-scale。');
  return { state, host, vault, org, old, marker, label, plistPath, projects, secrets, legacy };
}
export function planDeployment(opts: DeploymentOptions, system: DeploySystem = realSystem) {
  const c = context(opts, system);
  if (exists(path.join(c.state, 'pending-deployment.json'))) fail('INTERRUPTED_DEPLOYMENT', '上次部署未完成，先恢复事务', '运行 anc rollback，再重新预览。');
  const codex = c.host.codexPath ?? system.locate('codex'), gateway = c.host.gatewayPath ?? system.locate('cc-connect');
  if (!codex || !gateway) fail('MISSING_CLI', '未找到 Codex 或 cc-connect', '安装官方 CLI 和固定 gateway 版本后重试。');
  if (!path.isAbsolute(codex) || !path.isAbsolute(gateway)) fail('INVALID_EXECUTABLE_PATH', 'CLI 路径必须为绝对路径', '在 host.json 中填写明确的 codexPath/gatewayPath。');
  if (c.host.layout?.adapterWrapper && (!c.host.layout.adapterHash || sha(fs.readFileSync(c.host.layout.adapterWrapper)) !== c.host.layout.adapterHash)) fail('ADAPTER_DRIFT', '业务包装脚本与已核对版本不一致', '审阅脚本变化后更新本机 adapterHash；不静默运行变化的业务脚本。');
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
  const runtime: Runtime = { codex, gateway, credentials, adapterWrapper: c.host.layout?.adapterWrapper, adapterHash: c.host.layout?.adapterHash, path: process.env.PATH ?? '/usr/bin:/bin', environment, members: c.org.members.map(m => {
    const home = memberHome(c.host, c.state, m), filesystem: Record<string, string> = filesystemPolicy(c.vault, home, m.policy);
    const settings = c.host.layout?.members?.[m.id];
    for (const p of settings?.readPaths ?? []) {
      const actual = path.isAbsolute(p) ? (exists(p) ? fs.realpathSync(p) : canonicalRoot(p)) : '';
      const protectedPaths = [os.homedir(), c.state, c.vault, environment.CODEX_HOME!, ...(c.legacy ? [c.legacy.configPath] : [])];
      if (!actual || protectedPaths.some(secret => isWithin(actual,secret)) || isWithin(c.state,actual) || isWithin(environment.CODEX_HOME!,actual)) fail('INVALID_LAYOUT', '附加读取范围过宽或包含凭据', '只列出必要工具和业务数据的具体路径。');
      filesystem[actual] = 'read';
    }
    for (const p of settings?.denyPaths ?? []) {
      if (!path.isAbsolute(p)) fail('INVALID_LAYOUT', '禁止访问路径必须为绝对路径', '填写明确的本机路径。');
      filesystem[canonicalTarget(p)] = 'deny';
    }
    return { home, filesystem, project: projectName(c.host, c.org.id, m), delivery: settings?.delivery, openId: m.openId, toolPath: [...(settings?.toolPaths ?? []), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':') };
  }) };
  const files: Record<string, string> = {
    [path.join(c.state, 'config.toml')]: renderConfig(c.org, c.state, c.host),
    [path.join(c.state, 'runtime.json')]: json(runtime),
    [path.join(c.state, 'bin/codex')]: `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(cli)} _codex ${shellQuote(c.state)} "$@"\n`,
    [c.plistPath]: plist(c.label, process.execPath, [cli, '_gateway', c.state], c.state),
  };
  for (const m of c.org.members) {
    files[path.join(memberHome(c.host, c.state, m), 'AGENTS.md')] = persona(c.org, m, c.vault);
    files[path.join(memberHome(c.host, c.state, m), '.anc-bot-root')] = '';
  }
  for (const p of new Set([...Object.keys(files), ...Object.keys(c.old?.files ?? {})])) {
    assertTarget(p, c.state, c.plistPath, c.host);
    if (c.old?.files[p] && !exists(p)) fail('MISSING_MANAGED_FILE', `旧部署缺少受管文件：${p}`, '先从已验证备份恢复文件，避免切换到无法回滚的状态。');
    if (exists(p)) {
      const expected = c.old?.files[p] ?? (!c.old && opts.adopt ? c.legacy?.files[p] : undefined);
      if (!expected) fail('UNMANAGED_FILE', `拒绝接管非 anc 管理文件：${p}`, '已有部署先做影子迁移，不通过 init/deploy 自动覆盖。');
      if (sha(fs.readFileSync(p)) !== expected) fail('DEPLOYMENT_DRIFT', `生成文件已被手改：${p}`, '核对差异，将修改移回 org 后恢复受管文件。');
    }
  }
  const fingerprint = sha(json(files));
  const removed = Object.keys(c.old?.files ?? {}).filter(p => !(p in files));
  const changed = [...Object.entries(files).filter(([p, text]) => !exists(p) || sha(fs.readFileSync(p)) !== sha(text)).map(([p]) => p), ...removed];
  if (opts.view === 'personas' && (!c.old || changed.some(p => !c.org.members.some(m => p === path.join(memberHome(c.host, c.state, m), 'AGENTS.md'))))) fail('STRUCTURAL_CHANGE', 'personas 部署包含结构变化', '先使用 anc deploy config 审阅完整结构变更。');
  return { ...c, files, runtime, fingerprint, removed, changed };
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
export async function waitLegacyReady(record: Migration, offset: number, system: Pick<DeploySystem, 'run'>, timeout = 90000) {
  let previous = '', stable = 0;
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const live = system.run('launchctl', ['print', `gui/${process.getuid!()}/${record.label}`]);
    const pid = /\bpid = (\d+)/.exec(live.stdout)?.[1] ?? '';
    stable = live.status === 0 && pid && pid === previous && /state = running/.test(live.stdout) ? stable + 1 : 0; previous = pid;
    if (stable >= 2 && exists(record.logPath)) {
      const bytes = fs.readFileSync(record.logPath), fresh = bytes.subarray(bytes.length >= offset ? offset : 0).toString('utf8');
      const connected = (fresh.match(/\[connected to wss:\/\//g) ?? []).length, disconnected = (fresh.match(/\[disconnected to wss:\/\//g) ?? []).length;
      if (connected - disconnected >= record.projects.length && record.projects.every(p => fresh.includes(`"platform ready" project=${p} platform=feishu`))) return;
    }
    await delay(1000);
  }
  fail('LEGACY_RECOVERY_UNVERIFIED', '旧服务恢复尚未验证', '保留事务记录，检查旧网关日志后运行 anc rollback。');
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
  if (exists(existing) && plan.org.members.some(m => fs.readFileSync(existing, 'utf8').includes(m.appId)) && plan.legacy?.configPath !== existing) fail('EXISTING_BINDING', '应用已出现在另一份网关配置中', '走显式迁移流程，不能启动第二个网关抢连接。');
  const release = acquireLock(plan.state);
  try {
    const current = planDeployment(opts, system);
    if (current.fingerprint !== plan.fingerprint) fail('INPUT_CHANGED', '部署输入在预检期间变化', '重新预览并执行。');
    const live = system.run('launchctl', ['print', `gui/${process.getuid!()}/${plan.label}`]);
    if (live.status !== 0 && !serviceAbsent(live, plan.label)) fail('SERVICE_STATE_UNKNOWN', '无法确认现有服务状态', '检查 launchd GUI 域与访问权限后重试。');
    if (!plan.old && !plan.legacy && live.status === 0) fail('UNMANAGED_SERVICE', '同名 launchd 服务已存在但不归本部署管理', '先核对现有服务，不能自动 bootout 接管。');
    if (!plan.changed.length && plan.old && live.status === 0 && /state = running/.test(live.stdout)) {
      try {
        await system.ready(plan.label, path.join(plan.state, 'logs/gateway.log'), 0, plan.projects, 5000);
        const updated = { ...plan.old, sourceFingerprint: sourceFingerprint(plan.org, plan.secrets, plan.host) };
        if (updated.sourceFingerprint !== plan.old.sourceFingerprint) atomicWrite(plan.marker, json(updated), true);
        return { schemaVersion: 1, status: 'unchanged', projects: plan.projects };
      } catch { /* The managed service needs repair; continue through the transaction. */ }
    }
    if ((plan.old || plan.legacy) && live.status === 0) {
      const pid = /\bpid = (\d+)/.exec(live.stdout)?.[1];
      if (pid) {
        const ps = system.run('ps', ['-axo', 'pid=,ppid=,comm=']);
        if (ps.status !== 0) fail('UNKNOWN_ACTIVITY', '无法核实是否存在活动任务', '稍后重试；不打断未知运行状态的 bot。');
        const rows = ps.stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+/.exec(line)).filter(Boolean);
        const children = rows.filter(r => r![2] === pid).map(r => r![1]);
        if ((!plan.old && plan.legacy ? children.length > 0 : rows.some(r => children.includes(r![2])))) fail('BUSY', '网关仍有活动子任务', '等待任务完成后再部署。');
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
      const deployment: Deployment = { schemaVersion: 1, fingerprint: plan.fingerprint, sourceFingerprint: sourceFingerprint(plan.org, plan.secrets, plan.host), projects: plan.projects, label: plan.label, files: Object.fromEntries(Object.entries(plan.files).map(([p, text]) => [p, sha(text)])), installedAt: new Date().toISOString() };
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
      if (plan.legacy) {
        const offset = exists(plan.legacy.logPath) ? fs.statSync(plan.legacy.logPath).size : 0;
        await launch(plan.label, plan.plistPath, system);
        await (system.legacyReady ?? waitLegacyReady)(plan.legacy, offset, system);
        fs.unlinkSync(journal);
        fail('ROLLED_BACK', '接管失败，旧服务已恢复并重新连接', '检查本机日志后重新预览接管。', 3);
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
  const label = gatewayLabel(host), plistPath = path.join(system.launchAgentsDir, `${label}.plist`);
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
    if (!managedPath(p, state, plistPath, host) || (text !== null && typeof text !== 'string')) fail('INVALID_BACKUP', '备份中有非受管路径或非法内容', '人工核对备份，不执行恢复。');
    assertTarget(p, state, plistPath, host);
  }
    const previous = record.files[path.join(state, 'deployment.json')];
    if (previous) validateDeployment(JSON.parse(previous), state, label, plistPath, host);
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
    } else {
      const legacy = migration(state, host, plistPath);
      if (legacy && exists(plistPath)) {
        if (Object.entries(legacy.files).some(([p,h]) => !exists(p) || sha(fs.readFileSync(p)) !== h)) fail('INVALID_BACKUP', '恢复文件不匹配旧部署快照', '核对原始备份；不会启动未知旧服务。');
        const offset = exists(legacy.logPath) ? fs.statSync(legacy.logPath).size : 0;
        await launch(label, plistPath, system); await (system.legacyReady ?? waitLegacyReady)(legacy, offset, system);
      }
    }
    if (exists(journal)) fs.unlinkSync(journal);
    return { schemaVersion: 1, status: exists(marker) ? 'restored' : exists(plistPath) && exists(path.join(state,'migration.json')) ? 'legacy-restored' : 'not-deployed', backup: candidate };
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
  const label = gatewayLabel(host);
  validateDeployment(d, state, label, path.join(system.launchAgentsDir, `${label}.plist`), host);
  const drift = Object.entries(d.files).filter(([p, hash]) => !exists(p) || sha(fs.readFileSync(p)) !== hash).map(([p]) => p);
  let sourceChanged = false;
  try { const org = loadOrg(orgRoot(host)); sourceChanged = sourceFingerprint(org, activeSecrets(org, state), host) !== d.sourceFingerprint; } catch { sourceChanged = true; }
  const r = system.run('launchctl', ['print', `gui/${process.getuid!()}/${d.label}`]);
  const running = r.status === 0 && /state = running/.test(r.stdout);
  const unknown = r.status !== 0 && !serviceAbsent(r, d.label);
  return { schemaVersion: 1, status: drift.length || sourceChanged ? 'drift' : unknown ? 'unknown' : running ? 'running' : 'stopped', drift, sourceChanged, projects: d.projects, verification: 'process-only; use a real Feishu message to verify replies' };
}
const realSystem: DeploySystem = { launchAgentsDir: path.join(os.homedir(), 'Library/LaunchAgents'), locate, run, doctor, sandboxProbe, ready: waitReady };
