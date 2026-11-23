#!/usr/bin/env node
import * as readline from 'node:readline/promises';
import { AncError, fail, json } from './common.js';
import { init, savedIdentity } from './init.js';
import type { Identity } from './templates.js';
import { doctor } from './doctor.js';
import { deploy, gateway, status, rollback } from './deploy.js';
import { runCodex } from './codex-runner.js';
import { deploySkills, rollbackSkills, skillStatus } from './skills.js';
import { deployOperations, rollbackOperations, operationsStatus } from './operations.js';
import { adopt } from './adopt.js';
import { deliveryServer } from './delivery.js';
import { selftest } from './selftest.js';

const help = "anc — 飞书 × Codex 公司部署\n\nanc init [--dir PATH] [--state-dir PATH] [--dry-run] [--json]\n  --company-name NAME --company-id ID --member-name NAME --member-id ID\n  --harness codex --platform feishu --language zh-CN --timezone Asia/Shanghai\n  --non-interactive  缺少参数立即报错\nanc adopt --plan PATH [--state-dir PATH] [--apply] [--json]\nanc doctor [--dir PATH] [--state-dir PATH] [--probe] [--json]\nanc deploy config|personas [--state-dir PATH] [--apply] [--adopt] [--allow-scale] [--json]\nanc deploy skills [--state-dir PATH] [--name NAME,NAME] [--prune] [--apply] [--json]\nanc deploy operations [--state-dir PATH] [--apply] [--json]\nanc status [--state-dir PATH] [--probe] [--json]\nanc rollback [skills|operations] [--state-dir PATH] [--json]\nanc selftest --sandbox [--json]\n\ninit 只初始化文件。adopt 只准备现有服务接管。deploy 默认预览。\n先 deploy skills --apply，再 doctor、deploy config --apply 与 deploy operations --apply。\n远端同步须单独配置；启用前核对仓库上传范围。\nprivate 包尚未发布 npm。\n";
async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '_delivery') { if(argv.length!==2)throw Error(); deliveryServer(argv[1]!);return; }
  if (argv[0] === '_gateway') { if (argv.length !== 2) throw Error(); gateway(argv[1]!); return; }
  if (argv[0] === '_codex') { if (argv.length < 3) throw Error(); runCodex(argv[1]!, argv.slice(2)); return; }
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { console.log(help); return; }
  if (argv[0] === '--version') { console.log('0.1.0'); return; }
  const command = argv.shift();
  const target = command === 'deploy' ? argv.shift() : command === 'rollback' && argv[0] && !argv[0].startsWith('--') ? argv.shift() : undefined;
  if (command === 'deploy' && !['config', 'personas', 'skills', 'operations'].includes(target ?? '')) fail('UNKNOWN_COMMAND', 'deploy 支持 config、personas、skills、operations', '运行 anc --help。', 2);
  if (command === 'rollback' && target && !['skills', 'operations'].includes(target)) fail('UNKNOWN_COMMAND', 'rollback 子命令不支持此目标', '使用 rollback、rollback skills 或 rollback operations。', 2);
  const booleans = new Set(['dry-run', 'json', 'non-interactive', 'probe', 'apply', 'allow-scale', 'prune', 'adopt', 'sandbox']);
  const strings = new Set(['dir', 'state-dir', 'company-name', 'company-id', 'member-name', 'member-id', 'harness', 'platform', 'language', 'timezone', 'name', 'plan']);
  const opts: Record<string, string | boolean> = {};
  while (argv.length) {
    const arg = argv.shift()!;
    const key = arg.startsWith('--') ? arg.slice(2) : '';
    if (key in opts) fail('DUPLICATE_OPTION', `重复参数 ${arg}`, '每个参数仅提供一次。', 2);
    if (booleans.has(key)) opts[key] = true;
    else if (strings.has(key)) {
      const value = argv.shift();
      if (!value || value.startsWith('--')) fail('MISSING_VALUE', `${arg} 缺少值`, '补上参数值。', 2);
      opts[key] = value;
    } else fail('UNKNOWN_OPTION', `未知参数 ${arg}`, '运行 anc --help。', 2);
  }
  if (command === 'selftest') {
    if(!opts.sandbox || Object.keys(opts).some(k=>!['sandbox','json'].includes(k)))fail('MISSING_INPUT','selftest 需要 --sandbox','运行 anc selftest --sandbox。',2);
    process.stdout.write(json(await selftest()));return;
  }
  if (command === 'adopt') {
    for (const key of Object.keys(opts)) if (!['plan','state-dir','apply','json','dry-run'].includes(key)) fail('UNKNOWN_OPTION', `adopt 不接受 --${key}`, '运行 anc --help。', 2);
    if (!opts.plan || (opts.apply && opts['dry-run'])) fail('MISSING_INPUT', 'adopt 需要 --plan 且不能同时指定 apply/dry-run', '提供经核对的本机接管计划 JSON。', 2);
    process.stdout.write(json(adopt({ plan: opts.plan as string, stateDir: opts['state-dir'] as string | undefined, apply: !!opts.apply })));
    return;
  }
  if (command === 'deploy' || command === 'status' || command === 'rollback') {
    const allowed = command === 'deploy' ? ['state-dir', 'json', 'apply', 'dry-run', ...(target === 'skills' ? ['prune', 'name'] : target === 'operations' ? [] : ['dir','allow-scale','adopt'])] : ['state-dir', 'json', ...(command === 'status' ? ['probe'] : [])];
    for (const key of Object.keys(opts)) if (!allowed.includes(key)) fail('UNKNOWN_OPTION', `${command} 不接受 --${key}`, '运行 anc --help。', 2);
    if (opts.apply && opts['dry-run']) fail('CONFLICTING_OPTIONS', '--apply 与 --dry-run 冲突', '选择预览或应用。', 2);
    const input = { dir: opts.dir as string | undefined, stateDir: opts['state-dir'] as string | undefined, apply: !!opts.apply, allowScale: !!opts['allow-scale'], adopt: !!opts.adopt };
    const result = command === 'deploy'
      ? target === 'skills' ? deploySkills({ ...input, prune: !!opts.prune, names: typeof opts.name === 'string' ? opts.name.split(',').map(s => s.trim()) : undefined })
        : target === 'operations' ? await deployOperations(input)
        : await deploy({ ...input, view: target as 'config' | 'personas' })
      : command === 'rollback' ? target === 'skills' ? rollbackSkills(input.stateDir) : target === 'operations' ? await rollbackOperations(input.stateDir) : await rollback(input)
      : { ...status(input), skills: skillStatus(input.stateDir), operations: operationsStatus(input.stateDir), ...(opts.probe ? { probe: doctor({ ...input, probe: true }) } : {}) };
    process.stdout.write(json(result));
    if (command === 'status' && ['stopped', 'drift', 'not-deployed', 'recovery-required', 'unknown'].includes(result.status)) process.exitCode = 1;
    if (command === 'status' && 'operations' in result && (result.operations.status !== 'current' || result.skills.status !== 'current')) process.exitCode = 1;
    if ('probe' in result && result.probe?.status === 'blocked') process.exitCode = 1;
    return;
  }
  if (command === 'doctor') {
    for (const key of Object.keys(opts)) if (!['dir', 'state-dir', 'json', 'probe'].includes(key)) fail('UNKNOWN_OPTION', `doctor 不接受 --${key}`, '运行 anc --help。', 2);
    const result = doctor({ dir: opts.dir as string | undefined, stateDir: opts['state-dir'] as string | undefined, probe: !!opts.probe });
    if (opts.json) process.stdout.write(json(result));
    else for (const c of result.checks) console.log(`${c.status} ${c.id}: ${c.message}${c.fix ? `\n  FIX: ${c.fix}` : ''}`);
    if (result.status === 'blocked') process.exitCode = 1;
    return;
  }
  if (command !== 'init') fail('UNKNOWN_COMMAND', `未知命令 ${command}`, '运行 anc --help。', 2);
  for (const key of ['probe', 'apply', 'allow-scale', 'prune', 'name', 'adopt', 'plan', 'sandbox']) if (opts[key]) fail('UNKNOWN_OPTION', `init 不接受 --${key}`, '运行 anc --help。', 2);
  const identity: Partial<Identity> = {};
  for (const [flag, key] of Object.entries({ 'company-name': 'companyName', 'company-id': 'companyId', 'member-name': 'memberName', 'member-id': 'memberId', harness: 'harness', platform: 'platform', language: 'language', timezone: 'timezone' })) {
    if (opts[flag] !== undefined) (identity as Record<string, unknown>)[key] = opts[flag];
  }
  const saved = savedIdentity(opts['state-dir'] as string | undefined);
  const missing = (['companyName', 'companyId', 'memberName', 'memberId'] as const).filter(k => !identity[k] && !saved[k]);
  if (missing.length) {
    if (opts.json || opts['non-interactive'] || !process.stdin.isTTY) fail('MISSING_INPUT', `缺少 ${missing.join(', ')}`, '提供公司/成员名称和 ID；运行 anc --help 查看参数。', 2);
    const prompt = readline.createInterface({ input: process.stdin, output: process.stderr });
    const labels = { companyName: '公司名称', companyId: '公司 ID（小写英文）', memberName: '第一位使用者称呼', memberId: '成员 ID（小写英文）' };
    try { for (const key of missing) identity[key] = (await prompt.question(`${labels[key]}：`)).trim(); } finally { prompt.close(); }
  }
  const result = init({ dir: opts.dir as string | undefined, stateDir: opts['state-dir'] as string | undefined, dryRun: !!opts['dry-run'], identity });
  if (opts.json) process.stdout.write(json(result));
  else console.log(`${result.status === 'planned' ? '初始化预览' : '初始化完成'}：${result.vaultRoot}\n新建 ${result.created.length}，跳过 ${result.skipped.length}，保留修改 ${result.preserved.length}。\n尚未上线，请按 docs/SETUP-CHECKLIST.md 继续。`);
}
main().catch((error: unknown) => {
  const e = error instanceof AncError ? error : new AncError('IO_ERROR', '操作失败，文件系统或子进程不可用', '检查路径权限和磁盘；已有文件未自动覆盖，修复后重跑。');
  if (process.argv.includes('--json')) process.stdout.write(json({ schemaVersion: 1, status: 'error', error: { code: e.code, message: e.message, fix: e.fix } }));
  process.stderr.write(`ERROR: ${e.message}\nFIX: ${e.fix}\n`);
  process.exitCode = e.exitCode;
});
