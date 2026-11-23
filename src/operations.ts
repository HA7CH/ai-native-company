import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireLock, assertTree, atomicWrite, exists, fail, json, privateMode, readJSON, sha } from './common.js';
import { type Host, stateRoot } from './init.js';
import { gatewayLabel, orgRoot } from './layout.js';
import { loadOrg, readSecrets, secretName } from './org.js';
import { plistObject } from './render.js';
import { run } from './doctor.js';
import { launch, serviceAbsent, stop } from './launchd.js';
interface OperationsRecord { schemaVersion: 1; files: Record<string, string>; jobs: string[] }
export interface OperationsSystem { launchAgentsDir: string; run: typeof run }
const realSystem: OperationsSystem = { launchAgentsDir: path.join(os.homedir(), 'Library/LaunchAgents'), run };
export function planOperations(opts: { stateDir?: string }, system: OperationsSystem = realSystem) {
  const state = stateRoot(opts.stateDir); privateMode(state, 0o700);
  const host = readJSON<Host>(assertTree(state, 'host.json', 'file')), org = loadOrg(orgRoot(host));
  const marker = assertTree(state, 'operations-deployment.json', 'file');
  const old: OperationsRecord = exists(marker) ? readJSON<OperationsRecord>(marker) : { schemaVersion: 1, files: {}, jobs: [] };
  if (old.schemaVersion !== 1 || !old.files || !Array.isArray(old.jobs)) fail('INVALID_STATE', '运维部署记录不兼容', '恢复正确记录。');
  if (exists(path.join(state, 'pending-operations.json'))) fail('INTERRUPTED_OPERATIONS', '上次运维部署未完成', '运行 anc rollback operations。');
  const interval = host.operations?.watchdogIntervalSeconds ?? 60;
  if (!Number.isInteger(interval) || interval < 30 || interval > 3600) fail('INVALID_OPERATIONS', 'watchdog 周期必须为 30–3600 秒', '修正本机 operations 设置。');
  const alertMember = host.operations?.alertMember ? org.members.find(m => m.id === host.operations!.alertMember) : undefined;
  if (host.operations?.alertMember && !alertMember) fail('INVALID_OPERATIONS', '告警收件成员未启用', '选择明确授权接收告警的当前成员。');
  const privateFiles: Record<string, string> = {};
  let alertCredentials = '';
  if (alertMember) {
    const secretFile = assertTree(state, 'secrets.env', 'file'); privateMode(secretFile, 0o600);
    const secret = readSecrets(secretFile)[secretName(alertMember.id)];
    if (!secret || !alertMember.appId || !alertMember.openId) fail('MISSING_SECRETS', '告警机器人绑定或凭据缺失', '补全已授权成员的飞书绑定。');
    const request = json(Object.fromEntries([['app_id', alertMember.appId], ['app_secret', secret]]));
    alertCredentials = path.join(state, 'credentials', `alert-${sha(request)}.json`);
    privateFiles[alertCredentials] = request;
  }
  const files: Record<string, string> = {};
  for (const script of ['anc-sync.sh', 'anc-watchdog.sh', 'anc-alert.sh']) files[path.join(state, 'bin', script)] = fs.readFileSync(fileURLToPath(new URL(`../templates/scripts/${script}`, import.meta.url)), 'utf8');
  files[path.join(state, 'operations.plist')] = plistObject({ vault: host.vaultRoot, gatewayLabel: gatewayLabel(host), gatewayLog: path.join(state, 'logs/gateway.log'), projectCount: org.members.length, syncEnabled: !!org.syncEnabled, syncMaxAgeSeconds: Math.max(45 * 60, (org.syncIntervalMinutes ?? 15) * 3 * 60), alertEnabled: !!alertMember, alertCredentials, alertRecipient: alertMember?.openId ?? '' });
  const jobs: string[] = [];
  for (const [name, seconds, runAtLoad] of [['watchdog', interval, false], ...(org.syncEnabled ? [['vault-sync', (org.syncIntervalMinutes ?? 15) * 60, true]] : [])] as [string, number, boolean][]) {
    const label = `com.anc.${org.id}.${name}`; jobs.push(label);
    files[path.join(system.launchAgentsDir, `${label}.plist`)] = plistObject({ Label: label, ProgramArguments: ['/bin/sh', path.join(state, 'bin', name === 'watchdog' ? 'anc-watchdog.sh' : 'anc-sync.sh'), state], StartInterval: seconds, RunAtLoad: runAtLoad, WorkingDirectory: state, EnvironmentVariables: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, StandardOutPath: path.join(state, 'logs', `${name}.out.log`), StandardErrorPath: path.join(state, 'logs', `${name}.error.log`) });
  }
  const allowed = new Set([...Object.keys(files), ...['watchdog', 'vault-sync'].map(name => path.join(system.launchAgentsDir, `com.anc.${org.id}.${name}.plist`))]);
  for (const p of Object.keys(old.files)) if (!allowed.has(p)) fail('INVALID_STATE', '运维部署记录含非受管文件', '人工核对记录。');
  for (const p of new Set([...Object.keys(files), ...Object.keys(old.files)])) {
    assertTree(p.startsWith(state + path.sep) ? state : system.launchAgentsDir, p.startsWith(state + path.sep) ? path.relative(state, p) : path.basename(p), 'file');
    if (exists(p) && (!old.files[p] || sha(fs.readFileSync(p)) !== old.files[p])) fail('OPERATIONS_DRIFT', `运维文件未受管或被手改：${p}`, '核对差异后恢复受管版本。');
  }
  return { state, host, org, files, privateFiles, marker, old, jobs, allowed, changed: Object.keys(files).filter(p => !exists(p) || sha(fs.readFileSync(p)) !== sha(files[p]!)), removed: Object.keys(old.files).filter(p => !files[p]) };
}
export async function deployOperations(opts: { stateDir?: string; apply?: boolean }, system: OperationsSystem = realSystem) {
  let plan = planOperations(opts, system);
  if (!opts.apply) return { schemaVersion: 1, status: 'planned', changed: plan.changed, removed: plan.removed, jobs: plan.jobs, syncEnabled: !!plan.org.syncEnabled };
  if (plan.org.syncEnabled) {
    if (system.run('git', ['-C', plan.host.vaultRoot, 'rev-parse', '--abbrev-ref', '@{upstream}']).status !== 0) fail('NO_SYNC_UPSTREAM', '同步尚未配置上游', '核对私有远端内容后设置 origin 和 tracking branch。');
  }
  const release = acquireLock(plan.state);
  try {
    plan = planOperations(opts, system);
    let repair = Object.keys(plan.privateFiles).some(p => !exists(p));
    for (const [p, content] of Object.entries(plan.privateFiles)) if(exists(p)) { privateMode(p,0o600); if(sha(fs.readFileSync(p))!==sha(content)) fail('CREDENTIAL_DRIFT','告警凭据版本被修改','恢复正确凭据版本。'); }
    for (const label of plan.jobs) {
      const live = system.run('launchctl', ['print', `gui/${process.getuid!()}/${label}`]);
      if (live.status === 0 && !plan.old.jobs.includes(label)) fail('UNMANAGED_SERVICE', '同名运维服务未归 anc 管理', '核对旧服务后显式接管。');
      if (live.status !== 0 && !serviceAbsent(live, label)) fail('SERVICE_STATE_UNKNOWN', '无法确认运维服务状态', '检查 GUI 域权限。');
      if (serviceAbsent(live, label)) repair = true;
    }
    if (!plan.changed.length && !plan.removed.length && !repair) return { schemaVersion: 1, status: 'unchanged', jobs: plan.jobs };
    const before: Record<string, string | null> = {};
    for (const p of [...Object.keys(plan.files), ...plan.removed, plan.marker]) before[p] = exists(p) ? fs.readFileSync(p, 'utf8') : null;
    const record = { schemaVersion: 1, files: before, previousJobs: plan.old.jobs, jobs: plan.jobs };
    const backup = path.join(plan.state, 'backups', `operations-${Date.now()}.json`), journal = path.join(plan.state, 'pending-operations.json');
    atomicWrite(backup, json(record)); atomicWrite(journal, json({ backup }));
    try {
      for (const label of new Set([...plan.jobs, ...plan.old.jobs])) await stop(label, system);
      for (const [p, content] of Object.entries(plan.privateFiles)) {
        assertTree(plan.state, path.relative(plan.state, p), 'file');
        if (!exists(p)) atomicWrite(p, content);
        else if (sha(fs.readFileSync(p)) !== sha(content)) fail('CREDENTIAL_DRIFT', '告警凭据版本被修改', '恢复正确凭据版本。');
      }
      for (const [p, content] of Object.entries(plan.files)) atomicWrite(p, content, exists(p));
      for (const p of plan.removed) if (exists(p)) fs.unlinkSync(p);
      for (const label of plan.jobs) {
        const p = path.join(system.launchAgentsDir, `${label}.plist`);
        if (system.run('plutil', ['-lint', p]).status !== 0) fail('INVALID_PLIST', '运维 plist 校验失败', '修正生成器后恢复。');
        await launch(label, p, system);
        if (system.run('launchctl', ['print', `gui/${process.getuid!()}/${label}`]).status !== 0) fail('OPERATIONS_NOT_LOADED', '运维服务未注册成功', '检查 launchd。');
      }
      atomicWrite(plan.marker, json({ schemaVersion: 1, jobs: plan.jobs, files: Object.fromEntries(Object.entries(plan.files).map(([p, text]) => [p, sha(text)])) }), exists(plan.marker));
      fs.unlinkSync(journal);
      return { schemaVersion: 1, status: 'deployed', jobs: plan.jobs, syncEnabled: !!plan.org.syncEnabled };
    } catch (e) { await restoreOperations(plan.state, record, system); fs.unlinkSync(journal); throw e; }
  } finally { release(); }
}
interface OperationsBackup { schemaVersion: number; files: Record<string, string | null>; previousJobs: string[]; jobs: string[] }
async function restoreOperations(state: string, record: OperationsBackup, system: OperationsSystem) {
  for (const label of new Set([...record.jobs, ...record.previousJobs])) await stop(label, system);
  for (const [p, content] of Object.entries(record.files)) {
    if (content === null) { if (exists(p)) fs.unlinkSync(p); }
    else atomicWrite(p, content, exists(p));
  }
  for (const label of record.previousJobs) await launch(label, path.join(system.launchAgentsDir, `${label}.plist`), system);
}
export async function rollbackOperations(stateDir?: string, system: OperationsSystem = realSystem) {
  const state = stateRoot(stateDir), journal = assertTree(state, 'pending-operations.json', 'file');
  if (!exists(journal)) return { schemaVersion: 1, status: 'unchanged' };
  const release = acquireLock(state);
  try {
    const host = readJSON<Host>(assertTree(state, 'host.json', 'file'));
    const labels = ['watchdog', 'vault-sync'].map(n => `com.anc.${host.companyId}.${n}`);
    const backup = readJSON<{ backup: string }>(journal).backup;
    if (typeof backup !== 'string' || path.dirname(backup) !== path.join(state, 'backups') || !/^operations-\d+\.json$/.test(path.basename(backup))) fail('INVALID_STATE', '运维备份路径不合法', '人工核对恢复记录。');
    assertTree(state, path.relative(state, backup), 'file');
    const record = readJSON<OperationsBackup>(backup);
    if (record.schemaVersion !== 1 || !record.files || !Array.isArray(record.jobs) || !Array.isArray(record.previousJobs) || [...record.jobs, ...record.previousJobs].some(l => !labels.includes(l))) fail('INVALID_STATE', '运维恢复记录不合法', '人工核对恢复记录。');
    const allowed = new Set(['operations.plist', 'operations-deployment.json', 'bin/anc-sync.sh', 'bin/anc-watchdog.sh', 'bin/anc-alert.sh'].map(p => path.join(state, p)).concat(labels.map(l => path.join(system.launchAgentsDir, `${l}.plist`))));
    for (const [p, content] of Object.entries(record.files)) {
      if (!allowed.has(p) || (content !== null && typeof content !== 'string')) fail('INVALID_STATE', '运维恢复路径或内容越界', '人工核对恢复记录。');
      assertTree(p.startsWith(state + path.sep) ? state : system.launchAgentsDir, p.startsWith(state + path.sep) ? path.relative(state, p) : path.basename(p), 'file');
    }
    await restoreOperations(state, record, system); fs.unlinkSync(journal);
    return { schemaVersion: 1, status: 'restored' };
  } finally { release(); }
}
export function operationsStatus(stateDir?: string, system: OperationsSystem = realSystem) {
  const state = stateRoot(stateDir);
  if (exists(path.join(state, 'pending-operations.json'))) return { status: 'recovery-required' };
  if (!exists(path.join(state, 'operations-deployment.json'))) return { status: 'not-deployed' };
  try {
    const plan = planOperations({ stateDir }, system);
    const jobs = plan.jobs.map(label => ({ label, loaded: system.run('launchctl', ['print', `gui/${process.getuid!()}/${label}`]).status === 0 }));
    const watchdog = exists(path.join(state, 'watchdog-status.json')) ? readJSON<{ healthy: boolean; code: string; at: number }>(path.join(state, 'watchdog-status.json')) : null;
    const sync = exists(path.join(state, 'sync-status.json')) ? readJSON<Record<string, unknown>>(path.join(state, 'sync-status.json')) : null;
    const fresh = watchdog && Date.now() / 1000 - watchdog.at < (plan.host.operations?.watchdogIntervalSeconds ?? 60) * 3;
    return { status: plan.changed.length || plan.removed.length ? 'drift' : jobs.some(j => !j.loaded) ? 'stopped' : !fresh ? 'unknown' : !watchdog.healthy ? 'unhealthy' : 'current', jobs, watchdog, syncEnabled: !!plan.org.syncEnabled, sync };
  } catch { return { status: 'drift' }; }
}
