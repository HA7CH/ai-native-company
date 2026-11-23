// Gateway invokes this program as `codex`. It only mediates CLI configuration, not agent turns.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJSON, sha } from './common.js';
import { inlineTable } from './render.js';

export interface RuntimeMember { home: string; filesystem: Record<string, string>; project?: string; toolPath?: string; delivery?: boolean; openId?: string }
export interface Runtime { codex: string; gateway: string; credentials: string; path: string; environment: Record<string, string>; members: RuntimeMember[]; adapterWrapper?: string; adapterHash?: string }
export function codexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A bot must not inherit the desktop task's permission profile, tool bridge, or thread identity.
  // CODEX_HOME is the official user's auth/config directory, not a token extraction mechanism.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('ANC_FEISHU_SECRET_') && (!k.startsWith('CODEX_') || k === 'CODEX_HOME')));
}
export function guardedArgs(args: string[], filesystem: Record<string, string>, shellEnvironment: Record<string, string> = {}): string[] {
  const clean: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--sandbox' || a === '-s') { i++; continue; }
    if (a === '-c' || a === '--config') {
      const value = args[++i];
      if (!value || !/^(sandbox_mode|approval_policy|model_reasoning_effort)=/.test(value)) throw Error('Unsupported gateway config override');
      if (value.startsWith('model_reasoning_effort=')) clean.push('-c', value);
      continue;
    }
    if (a.startsWith('--dangerously') || a.startsWith('--sandbox=') || a === '--full-auto' || a === '--approve-for-me') throw Error('Unsafe gateway flag');
    clean.push(a);
  }
  if (clean[0] !== 'exec') throw Error('Only codex exec is supported by this adapter');
  clean.splice(1, 0, '--ignore-user-config', '--ignore-rules');
  for (const key of Object.keys(shellEnvironment)) if (!['PATH', 'CC_PROJECT', 'CC_SESSION_KEY', 'CC_API_SOCKET'].includes(key)) throw Error('Unsupported bot environment');
  return ['-c', 'approval_policy="never"', '-c', 'default_permissions="anc"', '-c', `permissions.anc.filesystem=${inlineTable(filesystem)}`, '-c', 'permissions.anc.network.enabled=false', '-c', 'shell_environment_policy.inherit="none"', '-c', 'shell_environment_policy.set.PATH="/usr/bin:/bin:/usr/sbin:/sbin"', ...Object.entries(shellEnvironment).flatMap(([k, v]) => ['-c', `shell_environment_policy.set.${k}=${JSON.stringify(v)}`]), '-c', 'features.apps=false', '-c', 'project_root_markers=[".anc-bot-root"]', ...clean];
}
export function runCodex(state: string, args: string[]) {
  const runtime = readJSON<Runtime>(path.join(state, 'runtime.json'));
  const cwd = fs.realpathSync(process.cwd());
  const member = runtime.members.find(m => m.home === cwd);
  if (!member) throw Error('Unrecognized bot workspace');
  if (member.project && process.env.CC_PROJECT && member.project !== process.env.CC_PROJECT) throw Error('Mismatched bot project');
  const env = codexEnvironment(process.env);
  if (runtime.adapterWrapper && (!runtime.adapterHash || sha(fs.readFileSync(runtime.adapterWrapper)) !== runtime.adapterHash)) throw Error('Business adapter changed');
  env.CC_CONFIG_PATH = path.join(state, 'config.toml');
  env.CC_CREDENTIALS_FILE = runtime.credentials;
  const shellEnvironment: Record<string, string> = { PATH: member.toolPath ?? '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of ['CC_PROJECT', 'CC_SESSION_KEY', 'CC_API_SOCKET']) if (env[key]) shellEnvironment[key] = env[key]!;
  const guarded = guardedArgs(args, member.filesystem, shellEnvironment);
  if (member.delivery) guarded.unshift('-c',`mcp_servers.anc_delivery.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.anc_delivery.args=${JSON.stringify([fileURLToPath(new URL('./cli.js',import.meta.url)),'_delivery',state])}`,'-c','mcp_servers.anc_delivery.env_vars=["FEISHU_VERIFIED_CHAT_MODE"]','-c',`mcp_servers.anc_delivery.env=${inlineTable(Object.fromEntries(['CC_PROJECT','CC_SESSION_KEY','CC_API_SOCKET'].filter(k=>env[k]).map(k=>[k,env[k]!])) )}`);
  if (member.delivery) guarded.unshift('-c',`mcp_servers.anc_delivery.cwd=${JSON.stringify(member.home)}`,'-c','mcp_servers.anc_delivery.enabled_tools=["delivery_status","send_attachment"]','-c','mcp_servers.anc_delivery.default_tools_approval_mode="prompt"','-c','mcp_servers.anc_delivery.tools.delivery_status.approval_mode="approve"','-c','mcp_servers.anc_delivery.tools.send_attachment.approval_mode="approve"');
  const child = spawn(runtime.adapterWrapper ?? runtime.codex, guarded, { stdio: 'inherit', env });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', () => { process.stderr.write('anc: official Codex CLI could not start\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
