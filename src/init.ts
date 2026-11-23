import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acquireLock, assertTree, atomicWrite, canonicalRoot, exists, fail, json, privateDir, privateMode, readJSON, sha } from './common.js';
import { templates, TEMPLATE_VERSION, type Identity } from './templates.js';
import type { HostLayout, OperationsHost } from './layout.js';

export interface InitInput { dir?: string; stateDir?: string; dryRun?: boolean; identity: Partial<Identity> }
export interface Manifest { schemaVersion: 1; templateVersion: number; initializationId: string; status: 'initializing' | 'initialized'; vaultRoot: string; identity: Identity; files: Record<string, string> }
export interface Host { schemaVersion: 1; companyId: string; vaultRoot: string; harness: 'codex'; gatewayVersion: string; codexPath?: string | null; gatewayPath?: string | null; layout?: HostLayout; operations?: OperationsHost }
export function stateRoot(input?: string): string { return canonicalRoot(input ?? path.join(os.homedir(), '.anc')); }
export function savedIdentity(stateDir?: string): Partial<Identity> {
  const p = path.join(stateRoot(stateDir), 'init-manifest.json');
  if (!exists(p)) return {};
  return validateManifest(readJSON<Manifest>(p)).identity;
}
function validateIdentity(i: Partial<Identity>): Identity {
  for (const key of ['companyId', 'memberId'] as const) if (!/^[a-z][a-z0-9-]{0,31}$/.test(i[key] ?? '')) fail('INVALID_ID', `${key} 必须为小写 ASCII ID（最多 32 字符）`, `提供 --${key === 'companyId' ? 'company-id' : 'member-id'}。`, 2);
  for (const key of ['companyName', 'memberName'] as const) if (!i[key]?.trim() || /[\r\n\x00-\x1f]/.test(i[key]!) || i[key]!.length > 120) fail('INVALID_NAME', `${key} 必须为 1–120 字的单行名称`, '提供有效公司和成员显示名。', 2);
  if (i.harness !== 'codex' || i.platform !== 'feishu') fail('UNSUPPORTED_BACKEND', '首版只支持 codex + feishu', '使用 --harness codex --platform feishu。', 2);
  try { new Intl.DateTimeFormat(i.language, { timeZone: i.timezone }).format(); } catch { fail('INVALID_LOCALE', '语言或时区不合法', '例如 zh-CN / Asia/Shanghai。', 2); }
  return i as Identity;
}
function validateManifest(m: Manifest): Manifest {
  if (m.schemaVersion !== 1 || m.templateVersion !== TEMPLATE_VERSION || typeof m.initializationId !== 'string' || !/^[0-9a-f-]{36}$/.test(m.initializationId) || !['initializing', 'initialized'].includes(m.status) || typeof m.vaultRoot !== 'string' || !m.identity || !m.files || typeof m.files !== 'object' || Array.isArray(m.files)) fail('INVALID_STATE', '初始化记录版本或结构不兼容', '使用匹配版本，或在备份后进行显式迁移。');
  validateIdentity(m.identity);
  return m;
}
export function planInit(input: InitInput) {
  const state = stateRoot(input.stateDir);
  const manifestPath = assertTree(state, 'init-manifest.json', 'file');
  const old = exists(manifestPath) ? validateManifest(readJSON<Manifest>(manifestPath)) : undefined;
  const i = validateIdentity({ language: 'zh-CN', timezone: 'Asia/Shanghai', harness: 'codex', platform: 'feishu', ...old?.identity, ...input.identity });
  if (old && json(i) !== json(old.identity)) fail('IDENTITY_CONFLICT', '输入与已初始化公司/成员身份不一致', '成员变更请编辑 org；不要通过重跑 init 改名。');
  const vault = canonicalRoot(input.dir ?? old?.vaultRoot ?? `./${i.companyId}-vault`);
  if (vault === state || vault.startsWith(state + path.sep) || state.startsWith(vault + path.sep)) fail('OVERLAPPING_ROOTS', 'vault 与本机状态目录不能互相包含', '把 secrets 和主机状态放到 vault 外。');
  if (old && old.vaultRoot !== vault) fail('HOST_ALREADY_BOUND', '该主机状态已绑定其他 vault', '继续使用原 vault；测试时使用独立 --state-dir。');
  if (!old && exists(vault) && fs.readdirSync(vault).length) fail('EXISTING_UNMANAGED_VAULT', '目标目录非空且没有 anc 初始化记录', '选择空目录；已有部署使用显式接管流程。');
  const marker = assertTree(vault, '.anc-init.json', 'file');
  if (exists(marker)) {
    const owner = readJSON<{ initializationId: string }>(marker);
    if (!old || owner.initializationId !== old.initializationId) fail('VAULT_ALREADY_BOUND', '此 vault 已由另一份主机状态初始化', '使用原主机状态；不要并行初始化同一个 vault。');
  }
  if (exists(state)) {
    privateMode(state, 0o700);
    // A crash before the first manifest's hardlink may leave an unpublished temp.
    // Preserve it, but do not mistake it for an unrelated company directory.
    const abandonedTemp = (name: string) => /^\.anc-[0-9a-f-]{36}\.tmp$/.test(name) && fs.lstatSync(path.join(state, name)).isFile() && (fs.statSync(path.join(state, name)).mode & 0o777) === 0o600;
    if (!old && fs.readdirSync(state).some(x => x !== '.anc.lock' && !abandonedTemp(x))) fail('EXISTING_UNMANAGED_STATE', '主机状态目录不归本次初始化管理', '保留现有目录，选择独立状态目录或恢复 manifest。');
  }
  const hostPath = assertTree(state, 'host.json', 'file');
  if (exists(hostPath)) {
    const host = readJSON<Host>(hostPath);
    if (host.schemaVersion !== 1 || host.companyId !== i.companyId || host.vaultRoot !== vault || host.harness !== 'codex') fail('IDENTITY_CONFLICT', 'host.json 与初始化记录不匹配', '从备份核对主机与 vault 的绑定。');
  }
  assertTree(state, 'secrets.env', 'file');
  if (exists(path.join(state, 'secrets.env'))) privateMode(path.join(state, 'secrets.env'), 0o600);
  for (const name of [`homes/${i.memberId}/attachments`, 'bin', 'logs', 'backups']) assertTree(state, name, 'directory');
  const content = templates(i);
  const created: string[] = [], skipped: string[] = [], preserved: string[] = [];
  for (const [rel, text] of Object.entries(content)) {
    const target = assertTree(vault, rel, 'file');
    if (!exists(target)) created.push(rel);
    else if (sha(fs.readFileSync(target)) === sha(text)) skipped.push(rel);
    else preserved.push(rel);
  }
  // Identity is immutable during init even when other user edits are preserved.
  if (old && exists(path.join(vault, 'company/company.md'))) {
    const company = fs.readFileSync(path.join(vault, 'company/company.md'), 'utf8');
    if (!company.split('\n').includes(`id: ${i.companyId}`)) fail('IDENTITY_CONFLICT', 'org 的 company ID 与主机绑定不同', '核对 company/company.md，不要以初始化覆盖公司身份。');
  }
  const routeA = path.join(vault, 'AGENTS.md'), routeC = path.join(vault, 'CLAUDE.md');
  if (exists(routeA) && exists(routeC) && sha(fs.readFileSync(routeA)) !== sha(fs.readFileSync(routeC))) fail('ROUTING_DRIFT', '根路由双文件内容不一致', '先人工合并 AGENTS.md 和 CLAUDE.md，再继续初始化。');
  return { state, vault, identity: i, old, content, created, skipped, preserved };
}
export function init(input: InitInput) {
  let plan = planInit(input);
  const pending: string[] = ['cli', 'auth', 'bindings', 'content', 'deploy', 'message', 'recovery', 'reboot'];
  if (!input.dryRun) {
    privateDir(plan.state);
    const release = acquireLock(plan.state);
    try {
      plan = planInit(input); // Recheck all conflicts after locking.
      const manifest: Manifest = plan.old ?? { schemaVersion: 1, templateVersion: TEMPLATE_VERSION, initializationId: randomUUID(), status: 'initializing', vaultRoot: plan.vault, identity: plan.identity, files: {} };
      const mp = path.join(plan.state, 'init-manifest.json');
      if (!plan.old) atomicWrite(mp, json(manifest));
      privateDir(plan.vault);
      const releaseVault = acquireLock(plan.vault);
      try {
      const marker = path.join(plan.vault, '.anc-init.json');
      if (exists(marker)) {
        if (readJSON<{ initializationId: string }>(marker).initializationId !== manifest.initializationId) fail('VAULT_ALREADY_BOUND', '另一个初始化进程已占用此 vault', '使用原主机状态，或选择空目录。');
      } else atomicWrite(marker, json({ schemaVersion: 1, companyId: plan.identity.companyId, initializationId: manifest.initializationId }));
      for (const [rel, content] of Object.entries(plan.content)) {
        const target = assertTree(plan.vault, rel, 'file');
        if (!exists(target)) {
          // If one routing mirror was edited, restore a missing mirror from its live counterpart.
          const peer = rel === 'AGENTS.md' ? 'CLAUDE.md' : rel === 'CLAUDE.md' ? 'AGENTS.md' : undefined;
          const text = peer && exists(path.join(plan.vault, peer)) ? fs.readFileSync(path.join(plan.vault, peer), 'utf8') : content;
          atomicWrite(target, text);
          manifest.files[rel] = sha(text);
          atomicWrite(mp, json(manifest), true);
        }
      }
      for (const rel of [`homes/${plan.identity.memberId}/attachments`, 'bin', 'logs', 'backups']) privateDir(assertTree(plan.state, rel, 'directory'));
      const host: Host = { schemaVersion: 1, companyId: plan.identity.companyId, vaultRoot: plan.vault, harness: 'codex', gatewayVersion: 'v1.3.4', codexPath: null, gatewayPath: null };
      if (!exists(path.join(plan.state, 'host.json'))) atomicWrite(path.join(plan.state, 'host.json'), json(host));
      const secretPath = path.join(plan.state, 'secrets.env');
      if (!exists(secretPath)) atomicWrite(secretPath, `# 本机私有；仅 KEY=value，禁止 shell 表达式。\nANC_FEISHU_SECRET_${plan.identity.memberId.toUpperCase().replaceAll('-', '_')}=\n`);
      if (!exists(path.join(plan.vault, '.git'))) {
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
        const r = spawnSync('git', ['init', '-q', plan.vault], { encoding: 'utf8', timeout: 15000, env });
        if (r.status !== 0) pending.unshift('git');
      }
      manifest.status = 'initialized';
      atomicWrite(mp, json(manifest), true);
      } finally { releaseVault(); }
    } finally { release(); }
  }
  return { schemaVersion: 1, status: input.dryRun ? 'planned' : 'initialized', vaultRoot: plan.vault, stateDir: plan.state, created: plan.created, skipped: plan.skipped, preserved: plan.preserved, pending, nextCommands: ['anc doctor', 'anc deploy config', 'anc deploy config --apply'] };
}
