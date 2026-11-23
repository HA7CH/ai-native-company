import * as fs from 'node:fs';
import * as path from 'node:path';
import { acquireLock, assertTree, atomicWrite, exists, fail, json, privateMode, readJSON, sha } from './common.js';
import { type Host, stateRoot } from './init.js';
import { orgRoot, memberHome, validateMemberHomes } from './layout.js';
import { loadOrg } from './org.js';
interface SkillRecord { hash: string; source: string; mode: number }
interface SkillManifest { schemaVersion: 1; files: Record<string, SkillRecord> }
export function skillPlan(opts: { stateDir?: string; names?: string[]; prune?: boolean }) {
  const state = stateRoot(opts.stateDir); privateMode(state, 0o700);
  const host = readJSON<Host>(assertTree(state, 'host.json', 'file')), root = orgRoot(host), org = loadOrg(root);
  const manifestPath = assertTree(state, 'skills.json', 'file');
  const old: SkillManifest = exists(manifestPath) ? readJSON<SkillManifest>(manifestPath) : { schemaVersion: 1, files: {} };
  if (old.schemaVersion !== 1 || !old.files) fail('INVALID_STATE', '技能部署记录不兼容', '恢复正确的技能记录。');
  const planned: Record<string, { bytes: Buffer; mode: number; source: string }> = {};
  const roots: string[] = [];
  const assigned = new Set(org.members.flatMap(m => m.skills ?? []));
  const homes = validateMemberHomes(host,state,org.members);
  const previousNames = new Set<string>();
  for (const p of Object.keys(old.files)) {
    const home=homes.find(h=>p.startsWith(path.join(h,'.agents/skills')+path.sep));
    if(!home) fail('INVALID_STATE','技能记录包含未注册成员路径','先核对旧技能与成员下线记录。');
    assertTree(home,path.relative(home,p),'file');
    previousNames.add(path.relative(path.join(home,'.agents/skills'),p).split(path.sep)[0]!);
  }
  for (const name of opts.names ?? []) if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || (!assigned.has(name) && !(opts.prune && previousNames.has(name)))) fail('UNKNOWN_SKILL', `技能未分配给启用成员：${name}`, '先分配；已卸任技能可用 --name NAME --prune 清理受管副本。');
  if (opts.prune && opts.names) for(const home of homes)for(const name of opts.names)roots.push(assertTree(home,`.agents/skills/${name}`,'directory'));
  for (const member of org.members) for (const name of member.skills ?? []) {
    if (opts.names?.length && !opts.names.includes(name)) continue;
    const source = assertTree(root, `skills/${name}`, 'directory');
    const home = memberHome(host, state, member), target = assertTree(home, `.agents/skills/${name}`, 'directory'); roots.push(target);
    const walk = (relative: string) => {
      const dir = assertTree(source, relative, 'directory');
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['.DS_Store', '.git', 'node_modules', '__pycache__'].includes(entry.name)) continue;
        const rel = path.join(relative, entry.name), input = assertTree(source, rel, entry.isDirectory() ? 'directory' : 'file');
        if (entry.isDirectory()) walk(rel);
        else {
          const bytes = fs.readFileSync(input), mode = fs.statSync(input).mode & 0o111 ? 0o700 : 0o600;
          if (bytes.length > 32 * 1024 * 1024) fail('SKILL_TOO_LARGE', '单个技能资源超过 32 MiB', '将大数据留在知识库，技能只保存运行资源。');
          planned[assertTree(target, rel, 'file')] = { bytes, mode, source: input };
        }
      }
    }; walk('');
  }
  const selected = (p: string) => roots.some(root => p.startsWith(root + path.sep));
  for (const [p, record] of Object.entries(old.files)) {
    if (!selected(p)) continue;
    if (exists(p) && sha(fs.readFileSync(p)) !== record.hash) fail('SKILL_DRIFT', `已部署技能被修改：${p}`, '先将改动合回 vault 技能源；不会直接覆盖。');
  }
  for (const p of Object.keys(planned)) if (exists(p) && !old.files[p]) fail('UNMANAGED_SKILL', `目标技能文件尚未归 anc 管理：${p}`, '先核对已有技能，再显式迁移；不覆盖其他来源的技能。');
  const changed = Object.keys(planned).filter(p => !exists(p) || sha(fs.readFileSync(p)) !== sha(planned[p]!.bytes) || (fs.statSync(p).mode & 0o777) !== planned[p]!.mode);
  const removed = opts.prune ? Object.keys(old.files).filter(p => selected(p) && !planned[p]) : [];
  return { state, manifestPath, old, planned, changed, removed };
}
export function deploySkills(opts: { stateDir?: string; names?: string[]; prune?: boolean; apply?: boolean }) {
  let plan = skillPlan(opts);
  if (!opts.apply) return { schemaVersion: 1, status: 'planned', changed: plan.changed, removed: plan.removed };
  const release = acquireLock(plan.state);
  try {
    plan = skillPlan(opts);
    const before: Record<string, { base64: string; mode: number } | null> = {};
    for (const p of [...plan.changed, ...plan.removed]) before[p] = exists(p) ? { base64: fs.readFileSync(p).toString('base64'), mode: fs.statSync(p).mode & 0o777 } : null;
    const journal = assertTree(plan.state, 'pending-skills.json', 'file');
    if (exists(journal)) fail('INTERRUPTED_SKILLS', '技能部署曾被中断', '运行 anc rollback skills 恢复后再部署。');
    const previousManifest = exists(plan.manifestPath) ? fs.readFileSync(plan.manifestPath, 'utf8') : null;
    atomicWrite(journal, json({ schemaVersion: 1, files: before, previousManifest }));
    try {
      for (const p of plan.changed) {
        const f = plan.planned[p]!;
        atomicWrite(p, f.bytes, exists(p)); fs.chmodSync(p, f.mode);
      }
      for (const p of plan.removed) if (exists(p)) fs.unlinkSync(p);
      const next: SkillManifest = { schemaVersion: 1, files: { ...plan.old.files } };
      for (const [p, f] of Object.entries(plan.planned)) next.files[p] = { hash: sha(f.bytes), source: f.source, mode: f.mode };
      for (const p of plan.removed) delete next.files[p];
      atomicWrite(plan.manifestPath, json(next), exists(plan.manifestPath));
      fs.unlinkSync(journal);
      return { schemaVersion: 1, status: plan.changed.length || plan.removed.length ? 'deployed' : 'unchanged', changed: plan.changed, removed: plan.removed };
    } catch (error) {
      restoreSkillFiles(before);
      if (previousManifest === null) { if (exists(plan.manifestPath)) fs.unlinkSync(plan.manifestPath); }
      else atomicWrite(plan.manifestPath, previousManifest, exists(plan.manifestPath));
      fs.unlinkSync(journal); throw error;
    }
  } finally { release(); }
}
export function rollbackSkills(stateDir?: string) {
  const state = stateRoot(stateDir), host = readJSON<Host>(assertTree(state, 'host.json', 'file'));
  const journal = assertTree(state, 'pending-skills.json', 'file');
  if (!exists(journal)) return { schemaVersion: 1, status: 'unchanged' };
  const release = acquireLock(state);
  try {
    const record = readJSON<{ schemaVersion: number; files: Record<string, { base64: string; mode: number } | null>; previousManifest: string | null }>(journal);
    if (record.schemaVersion !== 1 || !record.files || (record.previousManifest !== null && typeof record.previousManifest !== 'string')) fail('INVALID_STATE', '技能恢复记录不合法', '人工核对恢复记录。');
    for (const [p, value] of Object.entries(record.files)) {
      const index = p.indexOf('/.agents/skills/'), home = p.slice(0, index);
      const local = path.relative(path.join(state, 'homes'), home);
      const registered = Object.values(host.layout?.members ?? {}).some(m => m.home === home);
      if (index < 0 || (!registered && !/^[a-z][a-z0-9-]{0,31}$/.test(local))) fail('INVALID_STATE', '技能恢复路径越界', '仅恢复成员目录下的技能。');
      assertTree(home, path.relative(home, p), 'file');
      if (value && (typeof value.base64 !== 'string' || ![0o600, 0o700, 0o644, 0o755].includes(value.mode))) fail('INVALID_STATE', '技能恢复内容不合法', '人工核对恢复记录。');
    }
    restoreSkillFiles(record.files);
    const manifest = assertTree(state, 'skills.json', 'file');
    if (record.previousManifest === null) { if (exists(manifest)) fs.unlinkSync(manifest); }
    else atomicWrite(manifest, record.previousManifest, exists(manifest));
    fs.unlinkSync(journal);
    return { schemaVersion: 1, status: 'restored' };
  } finally { release(); }
}
function restoreSkillFiles(files: Record<string, { base64: string; mode: number } | null>) {
  for (const [p, old] of Object.entries(files)) {
    if (!old) { if (exists(p)) fs.unlinkSync(p); }
    else { atomicWrite(p, Buffer.from(old.base64, 'base64'), exists(p)); fs.chmodSync(p, old.mode); }
  }
}
export function skillStatus(stateDir?: string) {
  const state = stateRoot(stateDir);
  if (exists(path.join(state, 'pending-skills.json'))) return { status: 'recovery-required', changed: [] as string[] };
  try { const p = skillPlan({ stateDir }); return { status: p.changed.length ? 'drift' : 'current', changed: p.changed }; }
  catch { return { status: 'drift', changed: [] as string[] }; }
}
