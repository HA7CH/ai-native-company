// Gateway invokes this program as `codex`. It only mediates CLI configuration, not agent turns.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { readJSON } from './common.js';
import { inlineTable } from './render.js';

export interface RuntimeMember { home: string; filesystem: Record<string, string> }
export interface Runtime { codex: string; gateway: string; credentials: string; path: string; environment: Record<string, string>; members: RuntimeMember[] }
export function codexEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // A bot must not inherit the desktop task's permission profile, tool bridge, or thread identity.
  // CODEX_HOME is the official user's auth/config directory, not a token extraction mechanism.
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('ANC_FEISHU_SECRET_') && (!k.startsWith('CODEX_') || k === 'CODEX_HOME')));
}
export function guardedArgs(args: string[], filesystem: Record<string, string>): string[] {
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
  return ['-c', 'approval_policy="never"', '-c', 'default_permissions="anc"', '-c', `permissions.anc.filesystem=${inlineTable(filesystem)}`, '-c', 'permissions.anc.network.enabled=false', '-c', 'shell_environment_policy.inherit="none"', '-c', 'shell_environment_policy.set.PATH="/usr/bin:/bin:/usr/sbin:/sbin"', '-c', 'features.apps=false', '-c', 'project_root_markers=[".anc-bot-root"]', ...clean];
}
export function runCodex(state: string, args: string[]) {
  const runtime = readJSON<Runtime>(path.join(state, 'runtime.json'));
  const cwd = fs.realpathSync(process.cwd());
  const member = runtime.members.find(m => m.home === cwd);
  if (!member) throw Error('Unrecognized bot workspace');
  const env = codexEnvironment(process.env);
  const child = spawn(runtime.codex, guardedArgs(args, member.filesystem), { stdio: 'inherit', env });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal));
  child.on('error', () => { process.stderr.write('anc: official Codex CLI could not start\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
