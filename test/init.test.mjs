import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { init, planInit } from '../dist/init.js';
import { acquireLock, atomicWrite, sha } from '../dist/common.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, '公司 vault'), stateDir: path.join(root, 'state'), identity: { companyId: 'demo', companyName: '示例公司', memberId: 'alice', memberName: '小艾' } };
}
function snapshot(root) {
  if (!fs.existsSync(root)) return null;
  return Object.fromEntries(fs.readdirSync(root, { recursive: true }).filter(p => fs.lstatSync(path.join(root, p)).isFile()).map(p => [p, sha(fs.readFileSync(path.join(root, p)))]));
}
test('fresh init and repeat preserve edits/secrets and mirror missing routing', t => {
  const f = fixture(t), first = init(f);
  assert.equal(first.status, 'initialized'); assert(first.created.length > 10);
  assert.equal(fs.statSync(f.stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.stateDir, 'secrets.env')).mode & 0o777, 0o600);
  const file = path.join(f.dir, 'company/profile.md'); fs.appendFileSync(file, '\n用户自己的资料\n');
  const secret = path.join(f.stateDir, 'secrets.env'); fs.writeFileSync(secret, 'ANC_FEISHU_SECRET_ALICE=local-test-only\n');
  const before = snapshot(f.dir), beforeState = snapshot(f.stateDir);
  const second = init({ dir: f.dir, stateDir: f.stateDir, identity: {} });
  assert(second.preserved.includes('company/profile.md'));
  assert.equal(second.created.length, 0);
  assert.deepEqual(snapshot(f.dir), before); assert.deepEqual(snapshot(f.stateDir), beforeState);
  fs.appendFileSync(path.join(f.dir, 'AGENTS.md'), '\n人工路由补充\n');
  fs.unlinkSync(path.join(f.dir, 'CLAUDE.md'));
  init({ ...f, identity: {} });
  assert.equal(fs.readFileSync(path.join(f.dir, 'AGENTS.md'), 'utf8'), fs.readFileSync(path.join(f.dir, 'CLAUDE.md'), 'utf8'));
});
test('dry-run creates nothing including state and git', t => {
  const f = fixture(t), before = snapshot(f.root);
  assert.equal(init({ ...f, dryRun: true }).status, 'planned');
  assert.deepEqual(snapshot(f.root), before); assert(!fs.existsSync(f.stateDir));
});
test('unmanaged directory, path conflicts and symlinks are refused before changes', t => {
  const f = fixture(t); fs.mkdirSync(f.dir); fs.writeFileSync(path.join(f.dir, 'important'), 'keep');
  assert.throws(() => init(f), { code: 'EXISTING_UNMANAGED_VAULT' });
  assert(!fs.existsSync(f.stateDir));
  fs.rmSync(f.dir, { recursive: true }); fs.symlinkSync(f.root, f.dir);
  assert.throws(() => init(f), { code: 'UNSAFE_PATH' });
  fs.unlinkSync(f.dir); init(f);
  fs.rmSync(path.join(f.dir, 'knowledge'), { recursive: true }); fs.symlinkSync(f.root, path.join(f.dir, 'knowledge'));
  const before = snapshot(f.stateDir);
  assert.throws(() => init(f), { code: 'PATH_CONFLICT' });
  assert.deepEqual(snapshot(f.stateDir), before);
});
test('identity, state binding, manifest corruption, and duplicate routing reject unsafe rerun', t => {
  const f = fixture(t); init(f);
  assert.throws(() => init({ ...f, identity: { ...f.identity, companyId: 'other' } }), { code: 'IDENTITY_CONFLICT' });
  assert.throws(() => init({ ...f, dir: path.join(f.root, 'other') }), { code: 'HOST_ALREADY_BOUND' });
  fs.appendFileSync(path.join(f.dir, 'CLAUDE.md'), 'different');
  assert.throws(() => init(f), { code: 'ROUTING_DRIFT' });
  fs.writeFileSync(path.join(f.stateDir, 'init-manifest.json'), '{');
  assert.throws(() => init(f), { code: 'INVALID_STATE' });
});
test('partial initialized manifest resumes missing files without changing existing files', t => {
  const f = fixture(t); const plan = planInit(f);
  fs.mkdirSync(f.stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(f.stateDir, 'init-manifest.json'), JSON.stringify({ schemaVersion: 1, templateVersion: 1, initializationId: '00000000-0000-0000-0000-000000000001', status: 'initializing', vaultRoot: plan.vault, identity: plan.identity, files: {} }), { mode: 0o600 });
  fs.mkdirSync(f.dir); fs.writeFileSync(path.join(f.dir, 'AGENTS.md'), 'Existing generated file\n');
  assert.equal(init(f).status, 'initialized');
  assert.equal(fs.readFileSync(path.join(f.dir, 'AGENTS.md'), 'utf8'), 'Existing generated file\n');
  assert.equal(fs.readFileSync(path.join(f.dir, 'CLAUDE.md'), 'utf8'), 'Existing generated file\n');
});
test('atomic create never replaces a concurrently created target; live lock protects writes', t => {
  const f = fixture(t); fs.mkdirSync(f.stateDir, { mode: 0o700 });
  const p = path.join(f.stateDir, 'record'); atomicWrite(p, 'original');
  assert.throws(() => atomicWrite(p, 'replacement'), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(p, 'utf8'), 'original'); fs.unlinkSync(p);
  const release = acquireLock(f.stateDir);
  assert.throws(() => init(f), { code: 'LOCKED' });
  assert(!fs.existsSync(f.dir)); release();
  assert.equal(init(f).status, 'initialized');
});
test('bad secrets permission and overlapping roots are rejected', t => {
  const f = fixture(t);
  assert.throws(() => init({ ...f, stateDir: path.join(f.dir, '.anc') }), { code: 'OVERLAPPING_ROOTS' });
  init(f); fs.chmodSync(path.join(f.stateDir, 'secrets.env'), 0o644);
  assert.throws(() => init(f), { code: 'INSECURE_MODE' });
});
test('an unpublished pre-manifest atomic write does not strand init', t => {
  const f = fixture(t); fs.mkdirSync(f.stateDir, { mode: 0o700 });
  const abandoned = path.join(f.stateDir, '.anc-00000000-0000-0000-0000-000000000001.tmp');
  fs.writeFileSync(abandoned, '{"interrupted":"unpublished"}', { mode: 0o600 });
  assert.equal(init(f).status, 'initialized');
  assert.equal(fs.readFileSync(abandoned, 'utf8'), '{"interrupted":"unpublished"}');
});
test('two processes cannot claim one vault through different state directories', async t => {
  const f = fixture(t);
  const start = (state, name) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dist/cli.js', 'init', '--dir', f.dir, '--state-dir', state, '--company-id', 'demo', '--company-name', name, '--member-id', 'alice', '--member-name', 'Alice', '--json']);
    let output = ''; child.stdout.on('data', b => { output += b; }); child.stderr.on('data', () => {});
    child.on('error', reject); child.on('exit', code => resolve({ code, output: JSON.parse(output), state, name }));
  });
  const results = await Promise.all([start(f.stateDir, 'First'), start(path.join(f.root, 'second-state'), 'Second')]);
  assert.equal(results.filter(r => r.code === 0).length, 1);
  const winner = results.find(r => r.code === 0);
  const marker = JSON.parse(fs.readFileSync(path.join(f.dir, '.anc-init.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(winner.state, 'init-manifest.json'), 'utf8'));
  assert.equal(marker.initializationId, manifest.initializationId);
  assert(fs.readFileSync(path.join(f.dir, 'company/company.md'), 'utf8').includes(`name: "${winner.name}"`));
});
test('CLI machine protocol, unknown options and non-interactive errors', t => {
  const f = fixture(t);
  const run = args => spawnSync(process.execPath, ['dist/cli.js', ...args], { encoding: 'utf8' });
  let r = run(['init', '--state-dir', f.stateDir, '--json']);
  assert.equal(r.status, 2); assert.equal(JSON.parse(r.stdout).error.code, 'MISSING_INPUT');
  r = run(['init', '--force', '--json']); assert.equal(r.status, 2);
  r = run(['init', '--dir', f.dir, '--state-dir', f.stateDir, '--company-name', '例子', '--company-id', 'demo', '--member-name', 'Alice', '--member-id', 'alice', '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).status, 'initialized');
  r = run(['init', '--dir', f.dir, '--state-dir', f.stateDir, '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).created.length, 0);
});
