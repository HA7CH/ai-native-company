import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { acquireLock, assertTree, atomicWrite, canonicalRoot, exists, fail, json, privateDir, privateMode, readJSON, sha } from './common.js';
import { type Host, stateRoot } from './init.js';
import { legacyConfig, exactFields } from './legacy-config.js';
import { templates } from './templates.js';
import { roleTemplate } from './bundled.js';
import { secretName } from './org.js';
import { type MemberHost, validateMemberHomes } from './layout.js';
export interface AdoptionPlan {
  companyId: string; companyName: string; vaultRoot: string; configPath: string; label: string; logPath: string;
  codexPath: string; gatewayPath: string; adapterWrapper?: string;
  members: { id: string; name: string; project: string; readPaths?: string[]; toolPaths?: string[]; delivery?: boolean }[];
  alertMember?: string;
}
export interface Migration { schemaVersion: 1; label: string; configPath: string; configHash: string; logPath: string; projects: string[]; files: Record<string, string> }
export function migration(state: string, host: Host, plistPath: string): Migration | undefined {
  const p = assertTree(state, 'migration.json', 'file'); if (!exists(p)) return;
  const m = readJSON<Migration>(p);
  const allowed = new Set([plistPath, ...Object.values(host.layout?.members ?? {}).map(x => path.join(x.home, 'AGENTS.md'))]);
  if (m.schemaVersion !== 1 || m.label !== host.layout?.label || !path.isAbsolute(m.configPath) || !path.isAbsolute(m.logPath) || !Array.isArray(m.projects) || !m.projects.length || !m.files || Object.entries(m.files).some(([p, h]) => !allowed.has(p) || !/^[a-f0-9]{64}$/.test(h))) fail('INVALID_MIGRATION', '旧服务接管记录不合法', '核对本机 migration.json。');
  const current = assertTree(path.dirname(m.configPath), path.basename(m.configPath), 'file');
  if (!exists(current) || sha(fs.readFileSync(current)) !== m.configHash) fail('MIGRATION_DRIFT', '旧配置在接管准备后发生变化', '先核对旧部署变化，再重新准备接管；不启动第二份网关。');
  if (!exists(path.join(state,'deployment.json'))) verifyLegacyService(plistPath,{...m,gatewayPath:host.gatewayPath ?? ''});
  return m;
}
function verifyLegacyService(plistPath: string, input: {label:string; gatewayPath:string; configPath:string; logPath:string}) {
  const decoded = spawnSync('/usr/bin/plutil',['-convert','json','-o','-',plistPath],{encoding:'utf8',timeout:5000});
  let job: any; try { if(decoded.status!==0)throw Error(); job=JSON.parse(decoded.stdout); } catch { fail('INVALID_LEGACY_SERVICE','旧服务 plist 无法解析','核对指定 plist。'); }
  const argv = job.ProgramArguments;
  const effectiveConfig = Array.isArray(argv) && argv.length===1 ? path.join(os.homedir(),'.cc-connect/config.toml') : Array.isArray(argv) && argv.length===3 && argv[1]==='--config' ? argv[2] : undefined;
  if(job.Program!==undefined || job.Label!==input.label || !Array.isArray(argv) || typeof argv[0]!=='string' || !exists(argv[0]) || !exists(input.gatewayPath) || fs.realpathSync(argv[0])!==fs.realpathSync(input.gatewayPath) || typeof effectiveConfig!=='string' || !path.isAbsolute(effectiveConfig) || !exists(effectiveConfig) || fs.realpathSync(effectiveConfig)!==input.configPath || (job.EnvironmentVariables?.CC_LOG_FILE ?? job.StandardOutPath)!==input.logPath || (job.EnvironmentVariables?.HOME && job.EnvironmentVariables.HOME!==os.homedir())) fail('LEGACY_SERVICE_MISMATCH','旧服务与指定网关、配置或日志不匹配','仅接管以 ProgramArguments 直接启动的网关；核对配置和 HOME。');
}
export function adopt(opts: { plan: string; stateDir?: string; apply?: boolean; launchAgentsDir?: string }) {
  const input = readJSON<AdoptionPlan>(opts.plan), state = stateRoot(opts.stateDir);
  exactFields(input, ['companyId','companyName','vaultRoot','configPath','label','logPath','codexPath','gatewayPath','adapterWrapper','members','alertMember']);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(input.companyId) || !input.companyName || !Array.isArray(input.members) || !input.members.length || !/^[a-zA-Z][a-zA-Z0-9.-]{0,126}$/.test(input.label)) fail('INVALID_ADOPTION_PLAN', '接管身份或项目映射不合法', '使用稳定的公司和成员 ID，并明确映射每个现有项目。');
  const vault = canonicalRoot(input.vaultRoot), source = path.join(vault, '.anc-org');
  if (state === vault || state.startsWith(vault + path.sep) || vault.startsWith(state + path.sep)) fail('UNSAFE_PATH', '主机状态与知识库不能重叠', '将状态保存在知识库外的私有目录。');
  if (exists(path.join(state, 'host.json')) || exists(source)) fail('ALREADY_PREPARED', '接管已准备或目标 org 目录已存在', '检查已有状态后使用 deploy config；不覆盖已有接管。');
  if (exists(state) && fs.readdirSync(state).length) fail('UNMANAGED_STATE', '接管状态目录必须为空', '选择空的私有状态目录。');
  const configPath = assertTree(canonicalRoot(path.dirname(input.configPath)), path.basename(input.configPath), 'file'); privateMode(configPath, 0o600);
  const raw = fs.readFileSync(configPath, 'utf8'), config = legacyConfig(raw);
  exactFields(config, ['language','data_dir','log','instant_reply','stream_preview','projects']);
  if (config.language !== 'zh' || !Array.isArray(config.projects) || config.projects.length !== input.members.length) fail('UNSUPPORTED_LEGACY_CONFIG', '接管必须完整映射所有现有中文项目', '核对项目数，不跳过任何现有 bot。');
  if (config.log) { exactFields(config.log, ['level']); if (config.log.level !== 'info') fail('UNSUPPORTED_LEGACY_CONFIG', '旧日志级别需显式保留', '先补充日志 schema。'); }
  if (config.instant_reply) exactFields(config.instant_reply, ['enabled','content']);
  if (config.stream_preview) exactFields(config.stream_preview, ['enabled','interval_ms','min_delta_chars']);
  const plistPath = path.join(opts.launchAgentsDir ?? path.join(os.homedir(), 'Library/LaunchAgents'), `${input.label}.plist`);
  assertTree(path.dirname(plistPath), path.basename(plistPath), 'file');
  if (!exists(plistPath)) fail('MISSING_LEGACY_SERVICE', '指定旧服务 plist 不存在', '核对当前使用的服务 label。');
  verifyLegacyService(plistPath,{...input,configPath});
  for (const file of [input.codexPath,input.gatewayPath,...(input.adapterWrapper ? [input.adapterWrapper] : [])]) {
    if (!path.isAbsolute(file)) fail('INVALID_ADOPTION_PLAN', '可执行文件须为绝对路径', '提供实际安装路径。');
    fs.accessSync(file, fs.constants.X_OK);
  }
  const files: Record<string, string> = {}, secrets: Record<string, string> = {}, members: Record<string, MemberHost> = {};
  const snapshots: Record<string, string> = { [plistPath]: sha(fs.readFileSync(plistPath)) };
  const first = input.members[0]!;
  const base = templates({ companyId: input.companyId, companyName: input.companyName, memberId: first.id, memberName: first.name, language:'zh-CN',timezone:'Asia/Shanghai',harness:'codex',platform:'feishu' });
  for (const [p, content] of Object.entries(base)) if (p === 'company/company.md' || p.startsWith('roles/') || p.startsWith('skills/')) files[path.join(source,p)] = content;
  const seen = new Set<string>();
  for (const member of input.members) {
    exactFields(member, ['id','name','project','readPaths','toolPaths','delivery']);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(member.id) || !member.name || seen.has(member.id) || seen.has(`project:${member.project}`)) fail('INVALID_ADOPTION_PLAN', '成员映射非法或重复', '每个成员及旧项目只能映射一次。');
    seen.add(member.id); seen.add(`project:${member.project}`);
    const matches = config.projects.filter((p: any) => p.name === member.project); if (matches.length !== 1) fail('INVALID_ADOPTION_PLAN', '旧项目映射不唯一', '核对每个项目的准确名称。');
    const p = matches[0]; exactFields(p,['name','agent','platforms']); exactFields(p.agent,['type','options']); exactFields(p.agent.options,['work_dir','mode','model']);
    if (p.agent.type !== 'codex' || !['suggest','auto-edit'].includes(p.agent.options.mode) || !Array.isArray(p.platforms) || p.platforms.length !== 1) fail('UNSUPPORTED_LEGACY_CONFIG', '仅支持 Codex 保守权限与单飞书平台的接管', '先显式迁移不兼容能力。');
    const platform = p.platforms[0]; exactFields(platform,['type','options']); exactFields(platform.options,['app_id','app_secret','allow_from','progress_style']);
    const f = platform.options;
    if (platform.type !== 'feishu' || typeof f.app_id !== 'string' || !/^cli_[a-zA-Z0-9]+$/.test(f.app_id) || typeof f.allow_from !== 'string' || !/^ou_[a-zA-Z0-9]+$/.test(f.allow_from) || typeof f.app_secret !== 'string' || !f.app_secret || /\$|`|\n|\r/.test(f.app_secret)) fail('UNSUPPORTED_LEGACY_CONFIG', '接管要求每人独立飞书应用、单一本人白名单与可导入凭据', '核对绑定，环境引用需先通过私有凭据文件解析。');
    const home = canonicalRoot(p.agent.options.work_dir), persona = assertTree(home,'AGENTS.md','file');
    if (home === vault || home === state || home === os.homedir() || home === '/') fail('INVALID_ADOPTION_PLAN', '旧工作目录范围过宽', '每个机器人须有独立 cwd。');
    const body = fs.readFileSync(persona,'utf8'); snapshots[persona] = sha(body);
    members[member.id] = { project: member.project, home, readPaths: member.readPaths, toolPaths: member.toolPaths, progressStyle: f.progress_style, delivery: member.delivery };
    secrets[secretName(member.id)] = f.app_secret;
    files[path.join(source,`roles/${member.id}/persona.md`)] = roleTemplate(member.id, '成员助理', '保留服务对象中的既有业务约定；在有依据和明确授权的范围内协助本人。', p.agent.options.mode === 'suggest' ? 'readonly' : 'workspace');
    files[path.join(source,`members/${member.id}/persona.md`)] = `---\nname: ${member.id}\ndisplay_name: ${JSON.stringify(member.name)}\nrole: ${member.id}\nfeishu:\n  app_id: ${JSON.stringify(f.app_id)}\n  open_id: ${JSON.stringify(f.allow_from)}\nmodel: ${JSON.stringify(p.agent.options.model ?? '')}\ndisabled: false\n---\n\n${body}${member.delivery ? '\n\n# 托管附件回传\n上述交付约定保留；发送通道改用 anc_delivery 的 send_attachment 工具回传本次成品，不再从 shell 直接调用 cc-connect send。工具只允许当前本人会话和本工作目录内文件。先确认用户本次交付要求，成功须以网关回执为准。\n' : ''}`;
  }
  const host: Host = { schemaVersion:1, companyId:input.companyId, vaultRoot:vault, harness:'codex', gatewayVersion:'v1.3.4', codexPath:input.codexPath, gatewayPath:input.gatewayPath, layout:{orgRoot:source, dataDir:config.data_dir ? canonicalRoot(config.data_dir) : path.dirname(configPath), label:input.label, members, gatewaySettings:{...(config.instant_reply ? {instant_reply:config.instant_reply} : {}), ...(config.stream_preview ? {stream_preview:config.stream_preview} : {})},adapterWrapper:input.adapterWrapper,adapterHash:input.adapterWrapper ? sha(fs.readFileSync(input.adapterWrapper)) : undefined}, operations:input.alertMember ? {alertMember:input.alertMember} : undefined };
  const record: Migration = { schemaVersion:1, label:input.label, configPath, configHash:sha(raw), logPath:input.logPath, projects:input.members.map(m=>m.project), files:snapshots };
  validateMemberHomes(host,state,input.members,[configPath]);
  files[path.join(state,'host.json')] = json(host);
  files[path.join(state,'migration.json')] = json(record);
  files[path.join(state,'secrets.env')] = Object.entries(secrets).map(([k,v])=>`${k}=${JSON.stringify(v)}\n`).join('');
  const preview = {schemaVersion:1,status:opts.apply ? 'prepared' : 'planned',vaultRoot:vault,orgRoot:source,projects:record.projects,preserved:['project names','member cwd','gateway data directory','legacy config','existing business persona text'],created:Object.keys(files),nextCommands:['anc deploy skills --apply','anc doctor','anc deploy config --adopt','anc deploy config --adopt --apply']};
  if (opts.apply) {
    privateDir(state); const release = acquireLock(state), created: string[] = [];
    let releaseVault: (() => void) | undefined, ownsSource = false;
    try {
      releaseVault = acquireLock(vault);
      if (exists(source)) fail('ALREADY_PREPARED', '另一个接管已创建 org 目录', '检查已有接管状态。');
      privateDir(source); ownsSource = true;
      for (const [p, content] of Object.entries(files)) { atomicWrite(p,content); created.push(p); }
      for (const p of ['logs','backups','bin']) privateDir(path.join(state,p));
    } catch(e) { for (const p of created.reverse()) fs.unlinkSync(p); if (ownsSource) fs.rmSync(source,{recursive:true,force:true}); throw e; }
    finally { releaseVault?.(); release(); }
  }
  return preview;
}
