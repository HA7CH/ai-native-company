import * as path from 'node:path';
import * as os from 'node:os';
import { assertTree, canonicalRoot, exists, fail, isWithin, readJSON } from './common.js';
import type { Host } from './init.js';
import type { Member } from './org.js';
export interface MemberHost { project: string; home: string; readPaths?: string[]; denyPaths?: string[]; toolPaths?: string[]; progressStyle?: string; delivery?: boolean }
export interface GatewaySettings { instant_reply?: { enabled: boolean; content: string }; stream_preview?: { enabled: boolean; interval_ms: number; min_delta_chars: number } }
export interface HostLayout { orgRoot?: string; dataDir?: string; label?: string; members?: Record<string, MemberHost>; gatewaySettings?: GatewaySettings; adapterWrapper?: string; adapterHash?: string }
export interface OperationsHost { alertMember?: string; watchdogIntervalSeconds?: number }
export function orgRoot(host: Host): string {
  const root = canonicalRoot(host.layout?.orgRoot ?? host.vaultRoot);
  if (root !== host.vaultRoot && !root.startsWith(host.vaultRoot + path.sep)) fail('INVALID_LAYOUT', 'org 必须位于公司 vault 内', '把组织定义保留在公司的版本库内。');
  return root;
}
export function memberHome(host: Host, state: string, member: Pick<Member,'id'>): string {
  const home = canonicalRoot(host.layout?.members?.[member.id]?.home ?? path.join(state, 'homes', member.id));
  const auth = canonicalRoot(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'));
  const defaultHome = path.join(state,'homes',member.id);
  if (isWithin(home,os.homedir()) || isWithin(home,host.vaultRoot) || isWithin(host.vaultRoot,home) || isWithin(home,auth) || isWithin(auth,home) || (home!==defaultHome && (isWithin(home,state) || isWithin(state,home)))) fail('INVALID_LAYOUT', '成员 cwd 与知识库、登录凭据或主机状态重叠', '每个成员使用独立工作目录；仅允许默认 state/homes/<id> 位于主机状态下。');
  return home;
}
export function validateMemberHomes(host: Host, state: string, members: Pick<Member,'id'>[], protectedFiles: string[] = []): string[] {
  const record = assertTree(state,'migration.json','file');
  if (exists(record)) {
    const file = readJSON<{configPath:string}>(record).configPath;
    if(typeof file!=='string' || !path.isAbsolute(file)) fail('INVALID_LAYOUT','旧配置路径不合法','核对 migration.json。');
    protectedFiles = [...protectedFiles,file];
  }
  const homes=members.map(m=>memberHome(host,state,m));
  if(homes.some((home,i)=>homes.some((other,j)=>i!==j&&isWithin(home,other)) || protectedFiles.some(p=>isWithin(home,p)))) fail('INVALID_LAYOUT','成员目录互相重叠或包含旧网关凭据','每人一个独立且不含凭据的工作目录。');
  return homes;
}
export function projectName(host: Host, companyId: string, member: Member): string {
  const name = host.layout?.members?.[member.id]?.project ?? `${companyId}-${member.id}`;
  if (!name || /[\x00-\x1f]/.test(name)) fail('INVALID_LAYOUT', '项目名非法', '保留有效的旧项目名或使用默认成员项目名。');
  return name;
}
export function gatewayLabel(host: Host): string {
  const label = host.layout?.label ?? `com.anc.${host.companyId}.gateway`;
  if (!/^[a-zA-Z][a-zA-Z0-9.-]{0,126}$/.test(label)) fail('INVALID_LAYOUT', '服务 label 非法', '使用明确的 launchd label。');
  return label;
}
