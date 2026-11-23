import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { init } from '../dist/init.js';
import { frontmatter, loadOrg, readSecrets } from '../dist/org.js';
import { guardedArgs, codexEnvironment } from '../dist/codex-runner.js';
import { planDeployment, deploy, rollback, status, readyForPid, readyLogForPid } from '../dist/deploy.js';
import { filesystemPolicy, plist, renderConfig } from '../dist/render.js';
import { assertNamedPermissions } from '../dist/compat.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const options = { dir: path.join(root, 'vault'), stateDir: path.join(root, 'state') };
  init({ ...options, identity: { companyId: 'demo', companyName: '示例公司', memberId: 'alice', memberName: 'Alice' } });
  const member = path.join(options.dir, 'members/alice/persona.md');
  fs.writeFileSync(member, fs.readFileSync(member, 'utf8').replace('app_id: ""', `app_id: "${['cli', 'ancfixture1'].join('_')}"`).replace('open_id: ""', `open_id: "${['ou', 'ancfixture1'].join('_')}"`));
  fs.writeFileSync(path.join(options.stateDir, 'secrets.env'), 'ANC_FEISHU_SECRET_ALICE=fixture-secret-never-render\n');
  const calls = [];
  let running = false;
  const system = {
    launchAgentsDir: path.join(root, 'launchagents'),
    locate: name => `/fixture/bin/${name}`,
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'launchctl' && args[0] === 'bootout') running = false;
      if (cmd === 'launchctl' && args[0] === 'bootstrap') running = true;
      const absent = cmd === 'launchctl' && args[0] === 'print' && !running;
      return { status: absent ? 113 : 0, stdout: cmd === 'launchctl' && args[0] === 'print' && running ? 'state = running\npid = 999999' : '', stderr: absent ? `Could not find service "${args[1].split('/').at(-1)}" in domain for user gui: ${process.getuid()}` : '' };
    },
    doctor: () => ({ status: 'ready-to-deploy', checks: [] }),
    sandboxProbe: () => {},
    ready: async (...args) => { calls.push(['ready', ...args]); },
  };
  return { root, options, system, calls, member };
}
test('frontmatter rejects ambiguity, prototype keys, unsupported nesting and duplicates', () => {
  for (const body of ['a: x\na: y', 'a:\n  b:\n    c: x', 'constructor: x', 'a: &anchor', 'a: ["x", "y"]', ' a: x']) assert.throws(() => frontmatter(`---\n${body}\n---`, 'fixture'), { code: 'INVALID_ORG' });
  assert.equal(frontmatter('---\nname: "含冒号:及中文"\n---\nbody', 'fixture').fields.name, '含冒号:及中文');
});
test('legacy exec protocol is blocked before deployment, including legacy resume', () => {
  const modern = { properties: { permissions: {} } }, legacy = { properties: { sandbox: {} } };
  assert.throws(() => assertNamedPermissions(legacy, legacy), { code: 'INCOMPATIBLE_CODEX' });
  assert.throws(() => assertNamedPermissions(modern, legacy), { code: 'INCOMPATIBLE_CODEX' });
  assert.doesNotThrow(() => assertNamedPermissions(modern, modern));
});
test('secret parser is declarative and never evaluates shell expressions', t => {
  const f = fixture(t), p = path.join(f.options.stateDir, 'secrets.env');
  for (const body of ['ANC_FEISHU_SECRET_ALICE=$(touch BAD)', 'ANC_FEISHU_SECRET_ALICE=`whoami`', 'export ANC_FEISHU_SECRET_ALICE=x', 'ANC_FEISHU_SECRET_ALICE=x\nANC_FEISHU_SECRET_ALICE=y']) {
    fs.writeFileSync(p, body); assert.throws(() => readSecrets(p), { code: 'INVALID_SECRETS' });
  }
});
test('org blocks full privilege, duplicate bindings, unknown fields, and deployment preview is nonmutating', async t => {
  const f = fixture(t);
  let org = loadOrg(f.options.dir); assert.equal(org.members.length, 1);
  const rendered = renderConfig(org, f.options.stateDir);
  assert(rendered.includes('${ANC_FEISHU_SECRET_ALICE}')); assert(!rendered.includes('fixture-secret-never-render'));
  const plan = await deploy(f.options, f.system); assert.equal(plan.status, 'planned'); assert.equal(f.calls.length, 0);
  assert(!fs.existsSync(f.system.launchAgentsDir)); assert(!fs.existsSync(path.join(f.options.stateDir, 'runtime.json')));
  const memberText = fs.readFileSync(f.member, 'utf8');
  fs.appendFileSync(f.member, '\n');
  fs.writeFileSync(f.member, memberText.replace('disabled: false', 'disabled: false\nunknown: true'));
  assert.throws(() => loadOrg(f.options.dir), { code: 'UNKNOWN_ORG_FIELD' });
  fs.writeFileSync(f.member, memberText);
  const bob = path.join(f.options.dir, 'members/bob'); fs.mkdirSync(bob);
  fs.writeFileSync(path.join(bob, 'persona.md'), memberText.replace('name: alice', 'name: bob'));
  assert.throws(() => loadOrg(f.options.dir), { code: 'INVALID_BINDING' });
  fs.rmSync(bob, { recursive: true });
  const role = path.join(f.options.dir, 'roles/manager/persona.md');
  fs.writeFileSync(role, fs.readFileSync(role, 'utf8').replace('policy: readonly', 'policy: full'));
  assert.throws(() => loadOrg(f.options.dir), { code: 'UNSUPPORTED_POLICY' });
});
test('adapter applies identical named permissions on first exec and resume; rejects bypass', () => {
  assert.deepEqual(codexEnvironment({ PATH: '/bin', CODEX_HOME: '/auth', CODEX_PERMISSION_PROFILE: 'unsafe-parent', CODEX_APP_TOOLS_PIPE_PATH: 'private-bridge', CODEX_THREAD_ID: 'parent', ANC_FEISHU_SECRET_ALICE: 'not-in-child' }), { PATH: '/bin', CODEX_HOME: '/auth' });
  const fsPolicy = filesystemPolicy('/vault', '/home/bot', 'readonly');
  const first = guardedArgs(['exec', '--sandbox', 'read-only', '-c', 'approval_policy="never"', '--json', '-'], fsPolicy);
  const resume = guardedArgs(['exec', 'resume', '-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"', 'session', '--json', '-'], fsPolicy);
  assert.deepEqual(first.slice(0, 12), resume.slice(0, 12));
  assert(!first.includes('--sandbox')); assert(!resume.some(a => a.startsWith('sandbox_mode=')));
  assert(first.includes('default_permissions="anc"'));
  assert.throws(() => guardedArgs(['exec', '--dangerously-bypass-approvals-and-sandbox'], fsPolicy));
  assert.throws(() => guardedArgs(['exec', '-c', 'permissions.anc.filesystem={":root"="write"}'], fsPolicy));
  assert.equal(fsPolicy['/vault'], undefined); assert.equal(fsPolicy['/vault/knowledge'], 'read');
});
test('deploy writes secret-free config, stable metadata, and no-op avoids restart', async t => {
  const f = fixture(t);
  let result = await deploy({ ...f.options, apply: true }, f.system); assert.equal(result.status, 'deployed');
  const state = path.join(f.options.stateDir, 'deployment.json'); assert(fs.existsSync(state));
  assert(!fs.existsSync(path.join(f.options.stateDir, 'pending-deployment.json')));
  assert.equal(f.calls.filter(c => c[1] === 'bootstrap').length, 1);
  result = await deploy({ ...f.options, apply: true }, f.system); assert.equal(result.status, 'unchanged');
  assert.equal(f.calls.filter(c => c[1] === 'bootstrap').length, 1);
  for (const p of Object.keys(planDeployment(f.options, f.system).files)) assert(!fs.readFileSync(p, 'utf8').includes('fixture-secret-never-render'));
});
test('first deployment failure removes new files and does not falsely claim rollback', async t => {
  const f = fixture(t); f.system.ready = async () => { throw Error('simulated timeout'); };
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system), /simulated timeout/);
  for (const name of ['config.toml', 'runtime.json', 'deployment.json', 'pending-deployment.json']) assert(!fs.existsSync(path.join(f.options.stateDir, name)));
  assert.equal(fs.readdirSync(f.system.launchAgentsDir).length, 0);
});
test('update readiness failure restores previous file bytes and validates old service before exit 3', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  const file = path.join(f.options.stateDir, 'homes/alice/AGENTS.md'), old = fs.readFileSync(file, 'utf8');
  fs.appendFileSync(f.member, '\n新增称呼偏好\n');
  let attempts = 0; f.system.ready = async () => { if (++attempts === 1) throw Error('new config fails'); };
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system), { code: 'ROLLED_BACK', exitCode: 3 });
  assert.equal(attempts, 2); assert.equal(fs.readFileSync(file, 'utf8'), old);
});
test('failed recovery keeps journal and explicit rollback can resume it', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  fs.appendFileSync(f.member, '\n变更\n'); f.system.ready = async () => { throw Error('network unavailable'); };
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system));
  assert(fs.existsSync(path.join(f.options.stateDir, 'pending-deployment.json')));
  assert.throws(() => planDeployment(f.options, f.system), { code: 'INTERRUPTED_DEPLOYMENT' });
  f.system.ready = async () => {};
  assert.equal((await rollback(f.options, f.system)).status, 'restored');
});
test('unmanaged config and generated-file drift never get overwritten', async t => {
  const f = fixture(t), target = path.join(f.options.stateDir, 'config.toml');
  fs.writeFileSync(target, 'existing config');
  assert.throws(() => planDeployment(f.options, f.system), { code: 'UNMANAGED_FILE' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'existing config');
  fs.unlinkSync(target); await deploy({ ...f.options, apply: true }, f.system);
  fs.appendFileSync(target, '# hand edit');
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system), { code: 'DEPLOYMENT_DRIFT' });
});
test('plist preserves spaces and XML escapes without SessionCreate', () => {
  const xml = plist('com.anc.demo.gateway', '/Node & runtime/node', ['a<b', 'space path'], '/state');
  assert(xml.includes('&amp;')); assert(xml.includes('a&lt;b')); assert(!xml.includes('SessionCreate'));
});
test('readiness uses current PID and ignores old ready lines after restart', () => {
  const platform = 'msg="platform ready" project=demo-alice platform=feishu\n';
  const ready = platform + '[Info] [connected to wss://fixture.invalid]\n';
  assert.equal(readyForPid(`anc:boot pid=13\n${platform}`, '13', ['demo-alice']), false);
  assert.equal(readyForPid(`anc:boot pid=12\n${ready}anc:boot pid=13\n`, '13', ['demo-alice']), false);
  assert.equal(readyForPid(`anc:boot pid=13\n${ready}`, '13', ['demo-alice']), true);
  assert.equal(readyForPid(`anc:boot pid=13\n${ready}`, '13', ['demo-alice', 'demo-bob']), false);
  assert.equal(readyForPid(`anc:boot pid=13\n${ready}[Info] [disconnected to wss://fixture.invalid]\n`, '13', ['demo-alice']), false);
});
test('status reports unapplied org changes and interrupted recovery', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  f.system.run = () => ({ status: 0, stdout: 'state = running\npid = 123', stderr: '' });
  assert.equal(status(f.options, f.system).status, 'running');
  f.system.run = () => ({ status: 13, stdout: '', stderr: 'Permission denied' });
  assert.equal(status(f.options, f.system).status, 'unknown');
  f.system.run = () => ({ status: 0, stdout: 'state = running\npid = 123', stderr: '' });
  fs.appendFileSync(f.member, '\nnew instruction');
  assert.equal(status(f.options, f.system).status, 'drift');
  assert.equal(status(f.options, f.system).sourceChanged, true);
  fs.writeFileSync(path.join(f.options.stateDir, 'pending-deployment.json'), '{}');
  assert.equal(status(f.options, f.system).status, 'recovery-required');
});
test('rollback rejects a forged backup that would overwrite secrets', async t => {
  const f = fixture(t); const result = await deploy({ ...f.options, apply: true }, f.system);
  const record = JSON.parse(fs.readFileSync(result.backup, 'utf8'));
  record.files[path.join(f.options.stateDir, 'secrets.env')] = 'replacement';
  fs.writeFileSync(result.backup, JSON.stringify(record));
  const before = f.calls.length;
  await assert.rejects(rollback(f.options, f.system), { code: 'INVALID_BACKUP' });
  assert.equal(f.calls.length, before);
  assert.match(fs.readFileSync(path.join(f.options.stateDir, 'secrets.env'), 'utf8'), /fixture-secret-never-render/);
});
test('apply restarts an unchanged but stopped managed service', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  f.system.run('launchctl', ['bootout', 'test']);
  assert.equal((await deploy({ ...f.options, apply: true }, f.system)).status, 'deployed');
  assert.equal(f.calls.filter(c => c[1] === 'bootstrap').length, 2);
});
test('secret rotation restarts and failed rotation restores the previous private generation', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  const runtime = path.join(f.options.stateDir, 'runtime.json');
  const previous = JSON.parse(fs.readFileSync(runtime, 'utf8'));
  fs.writeFileSync(path.join(f.options.stateDir, 'secrets.env'), 'ANC_FEISHU_SECRET_ALICE=rotated-fixture\n');
  assert.equal(status(f.options, f.system).sourceChanged, true);
  assert(planDeployment(f.options, f.system).changed.includes(fs.realpathSync(runtime)));
  let attempts = 0;
  f.system.ready = async () => { if (++attempts === 1) throw Error('bad new credential'); };
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system), { code: 'ROLLED_BACK' });
  assert.equal(JSON.parse(fs.readFileSync(runtime, 'utf8')).credentials, previous.credentials);
  assert.match(fs.readFileSync(previous.credentials, 'utf8'), /fixture-secret-never-render/);
  assert.equal(fs.statSync(previous.credentials).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(f.options.stateDir, 'secrets.env'), 'utf8'), /rotated-fixture/);
});
test('runtime preserves the shell Codex home used by doctor', t => {
  const f = fixture(t), previous = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(f.root, 'alternate-auth');
    assert.equal(planDeployment(f.options, f.system).runtime.environment.CODEX_HOME, process.env.CODEX_HOME);
  } finally { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; }
});
test('failed unload keeps the recovery journal and generated files', async t => {
  const f = fixture(t), ordinary = f.system.run;
  let bootstrap = false;
  f.system.run = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'bootstrap') bootstrap = true;
    if (bootstrap && cmd === 'launchctl' && args[0] === 'print') return { status: 0, stdout: 'state = running\npid = 999999', stderr: '' };
    return ordinary(cmd, args);
  };
  f.system.ready = async () => { throw Error('simulated first-start error'); };
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system), { code: 'STOP_UNVERIFIED' });
  assert(fs.existsSync(path.join(f.options.stateDir, 'pending-deployment.json')));
  assert(fs.existsSync(path.join(f.options.stateDir, 'runtime.json')));
});
test('unknown launchctl state preserves the live generation and recovery journal', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  const runtime = path.join(f.options.stateDir, 'runtime.json'), original = fs.readFileSync(runtime, 'utf8');
  fs.appendFileSync(f.member, '\nCandidate change');
  const ordinary = f.system.run; let stopping = false;
  f.system.run = (cmd, args) => {
    if (cmd === 'launchctl' && args[0] === 'bootout') { stopping = true; return { status: 5, stdout: '', stderr: 'permission denied' }; }
    if (stopping && cmd === 'launchctl' && args[0] === 'print') return { status: 113, stdout: '', stderr: 'Could not find domain for user gui' };
    return ordinary(cmd, args);
  };
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system), { code: 'SERVICE_STATE_UNKNOWN' });
  assert.equal(fs.readFileSync(runtime, 'utf8'), original);
  assert(fs.existsSync(path.join(f.options.stateDir, 'pending-deployment.json')));
});
test('runtime files are switched only after the old gateway is unloaded', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  const persona = path.join(f.options.stateDir, 'homes/alice/AGENTS.md'), previous = fs.readFileSync(persona, 'utf8');
  fs.appendFileSync(f.member, '\nUpdated instruction');
  const ordinary = f.system.run; let checked = false;
  f.system.run = (cmd, args) => {
    if (!checked && cmd === 'launchctl' && args[0] === 'bootout') { assert.equal(fs.readFileSync(persona, 'utf8'), previous); checked = true; }
    return ordinary(cmd, args);
  };
  assert.equal((await deploy({ ...f.options, apply: true }, f.system)).status, 'deployed');
  assert(checked); assert.notEqual(fs.readFileSync(persona, 'utf8'), previous);
});
test('missing old runtime blocks an update that could not be rolled back', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  fs.unlinkSync(path.join(f.options.stateDir, 'runtime.json'));
  const count = f.calls.length;
  await assert.rejects(deploy({ ...f.options, apply: true }, f.system), { code: 'MISSING_MANAGED_FILE' });
  assert.equal(f.calls.length, count);
});
test('startup evidence older than 2 MiB keeps a healthy unchanged service running', async t => {
  const f = fixture(t); await deploy({ ...f.options, apply: true }, f.system);
  const log = path.join(f.options.stateDir, 'logs/gateway.log');
  fs.writeFileSync(log, 'anc:boot pid=999999\nmsg="platform ready" project=demo-alice platform=feishu\n[Info] [connected to wss://fixture.invalid]\n' + 'routine log entry\n'.repeat(160000));
  f.system.ready = async () => { assert(readyLogForPid(log, '999999', ['demo-alice'])); };
  assert.equal((await deploy({ ...f.options, apply: true }, f.system)).status, 'unchanged');
  assert.equal(f.calls.filter(c => c[1] === 'bootstrap').length, 1);
});
