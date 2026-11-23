import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { init } from '../dist/init.js';
import { deploySkills, skillStatus, rollbackSkills } from '../dist/skills.js';
import { planOperations, deployOperations, operationsStatus } from '../dist/operations.js';
import { plistObject } from '../dist/render.js';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-ops-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const opts = { dir: path.join(root, 'vault'), stateDir: path.join(root, 'state') };
  init({ ...opts, identity: { companyId: 'demo', companyName: 'Demo', memberId: 'alice', memberName: 'Alice' } });
  const member = path.join(opts.dir, 'members/alice/persona.md');
  fs.writeFileSync(member, fs.readFileSync(member, 'utf8').replace('app_id: ""', `app_id: "${['cli', 'fixtureOnly'].join('_')}"`).replace('open_id: ""', `open_id: "${['ou', 'fixtureOnly'].join('_')}"`));
  fs.writeFileSync(path.join(opts.stateDir, 'secrets.env'), 'ANC_FEISHU_SECRET_ALICE=fixture-secret-not-for-output\n');
  const loaded = new Set(), calls = [];
  const system = { launchAgentsDir: path.join(root, 'LaunchAgents'), run(cmd, args) {
    calls.push([cmd, ...args]);
    if (cmd !== 'launchctl') return { status: 0, stdout: '', stderr: '' };
    const label = args[0] === 'bootstrap' ? path.basename(args[2], '.plist') : args[1].split('/').at(-1);
    if (args[0] === 'bootout') loaded.delete(label);
    if (args[0] === 'bootstrap') loaded.add(label);
    const absent = args[0] === 'print' && !loaded.has(label);
    return { status: absent ? 113 : 0, stdout: absent ? '' : 'state = waiting', stderr: absent ? `Could not find service "${label}" in domain for user gui: ${process.getuid()}` : '' };
  } };
  return { root, opts, system, loaded, calls };
}
test('assigned skills deploy binary resources, preserve extras, and prune only explicitly', t => {
  const f = fixture(t), skill = path.join(f.opts.dir, 'skills/now'), resource = path.join(skill, 'asset.bin');
  const bytes = Buffer.from([0, 255, 254, 128, 23]); fs.writeFileSync(resource, bytes);
  const target = path.join(f.opts.stateDir, 'homes/alice/.agents/skills/now/asset.bin');
  assert.equal(deploySkills(f.opts).status, 'planned'); assert(!fs.existsSync(target));
  assert.equal(deploySkills({ ...f.opts, apply: true }).status, 'deployed');
  assert.deepEqual(fs.readFileSync(target), bytes); assert.equal(skillStatus(f.opts.stateDir).status, 'current');
  fs.unlinkSync(resource);
  deploySkills({ ...f.opts, apply: true }); assert(fs.existsSync(target));
  deploySkills({ ...f.opts, apply: true, prune: true }); assert(!fs.existsSync(target));
  const file = path.join(path.dirname(target), 'SKILL.md'); fs.appendFileSync(file, '\nLocal edit');
  assert.throws(() => deploySkills({ ...f.opts, apply: true }), { code: 'SKILL_DRIFT' });
});
test('skills reject symlink resources and recover an interrupted binary write', t => {
  const f = fixture(t); deploySkills({ ...f.opts, apply: true });
  const manifest = path.join(f.opts.stateDir, 'skills.json'), previousManifest = fs.readFileSync(manifest, 'utf8');
  const target = fs.realpathSync(path.join(f.opts.stateDir, 'homes/alice/.agents/skills/now/SKILL.md'));
  const original = fs.readFileSync(target);
  fs.writeFileSync(path.join(f.opts.stateDir, 'pending-skills.json'), JSON.stringify({ schemaVersion: 1, previousManifest, files: { [target]: { base64: original.toString('base64'), mode: 0o600 } } }));
  fs.writeFileSync(target, 'interrupted');
  assert.equal(rollbackSkills(f.opts.stateDir).status, 'restored'); assert.deepEqual(fs.readFileSync(target), original);
  fs.symlinkSync('/etc/passwd', path.join(f.opts.dir, 'skills/now/leak'));
  assert.throws(() => deploySkills(f.opts), { code: 'PATH_CONFLICT' });
});
test('prune refuses a replaced parent symlink and can retire an unassigned skill explicitly',t=>{
  const f=fixture(t),source=path.join(f.opts.dir,'skills/now/resource');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'data'),'original');
  deploySkills({...f.opts,apply:true});fs.rmSync(source,{recursive:true});
  const target=path.join(f.opts.stateDir,'homes/alice/.agents/skills/now/resource'),outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'data'),'original');fs.rmSync(target,{recursive:true});fs.symlinkSync(outside,target);
  assert.throws(()=>deploySkills({...f.opts,apply:true,prune:true}),{code:'PATH_CONFLICT'});assert.equal(fs.readFileSync(path.join(outside,'data'),'utf8'),'original');
  fs.unlinkSync(target);fs.mkdirSync(target);fs.writeFileSync(path.join(target,'data'),'original');
  const role=path.join(f.opts.dir,'roles/manager/persona.md');fs.writeFileSync(role,fs.readFileSync(role,'utf8').replace('[now, content-check]','[content-check]'));
  deploySkills({...f.opts,apply:true,prune:true,names:['now']});assert(!fs.existsSync(path.join(path.dirname(target),'SKILL.md')));
});
test('skill deployment rejects two members sharing a workspace before copying files',t=>{
  const f=fixture(t),member=fs.readFileSync(path.join(f.opts.dir,'members/alice/persona.md'),'utf8');fs.mkdirSync(path.join(f.opts.dir,'members/bob'));
  fs.writeFileSync(path.join(f.opts.dir,'members/bob/persona.md'),member.replace('name: alice','name: bob').replaceAll('fixtureOnly','fixtureSecond'));
  const home=path.join(f.root,'shared');fs.mkdirSync(home);const p=path.join(f.opts.stateDir,'host.json'),host=JSON.parse(fs.readFileSync(p));host.layout={members:{alice:{project:'alice',home},bob:{project:'bob',home}}};fs.writeFileSync(p,JSON.stringify(host));
  assert.throws(()=>deploySkills({...f.opts,apply:true}),{code:'INVALID_LAYOUT'});assert(!fs.existsSync(path.join(home,'.agents')));
});
test('operations preview is nonmutating, secret-free and only enables configured sync', async t => {
  const f = fixture(t), hostPath = path.join(f.opts.stateDir, 'host.json');
  const host = JSON.parse(fs.readFileSync(hostPath)); host.operations = { alertMember: 'alice' }; fs.writeFileSync(hostPath, JSON.stringify(host));
  const preview = await deployOperations(f.opts, f.system);
  assert.equal(preview.status, 'planned'); assert.equal(preview.jobs.length, 1); assert.equal(f.calls.length, 0);
  assert(!JSON.stringify(preview).includes('fixture-secret'));
  assert(!fs.existsSync(f.system.launchAgentsDir));
  const plan = planOperations(f.opts, f.system);
  assert(!JSON.stringify(plan.files).includes('fixture-secret'));
  assert(Object.values(plan.privateFiles).some(text => text.includes('fixture-secret')));
  assert.equal((await deployOperations({ ...f.opts, apply: true }, f.system)).status, 'deployed');
  assert.equal((await deployOperations({ ...f.opts, apply: true }, f.system)).status, 'unchanged');
  for (const p of Object.keys(plan.privateFiles)) assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(f.opts.stateDir, 'watchdog-status.json'), JSON.stringify({ healthy: true, code: 'OK', at: Math.floor(Date.now()/1000) }));
  assert.equal(operationsStatus(f.opts.stateDir, f.system).status, 'current');
});
test('unmanaged operations service is never taken over', async t => {
  const f = fixture(t); f.loaded.add('com.anc.demo.watchdog');
  await assert.rejects(deployOperations({ ...f.opts, apply: true }, f.system), { code: 'UNMANAGED_SERVICE' });
  assert(f.loaded.has('com.anc.demo.watchdog')); assert(!fs.existsSync(f.system.launchAgentsDir));
});
test('sync script fast-forwards and preserves dirty or divergent work', { skip: process.platform !== 'darwin' }, t => {
  const f = fixture(t), bare = path.join(f.root, 'remote.git'), producer = path.join(f.root, 'producer'), consumer = path.join(f.root, 'consumer');
  const git = (...args) => { const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  git('init', '--bare', '-b', 'main', bare); git('init', '-b', 'main', producer);
  fs.writeFileSync(path.join(producer, 'fact.md'), 'one'); git('-C', producer, 'add', '.'); git('-C', producer, 'commit', '-m', 'one'); git('-C', producer, 'remote', 'add', 'origin', bare); git('-C', producer, 'push', '-u', 'origin', 'main'); git('clone', bare, consumer);
  fs.writeFileSync(path.join(f.opts.stateDir, 'operations.plist'), plistObject({ vault: consumer, syncEnabled: true }));
  const sync = () => { const r = spawnSync('/bin/sh', ['templates/scripts/anc-sync.sh', f.opts.stateDir], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return JSON.parse(fs.readFileSync(path.join(f.opts.stateDir, 'sync-status.json'))); };
  fs.writeFileSync(path.join(producer, 'fact.md'), 'two'); git('-C', producer, 'commit', '-am', 'two'); git('-C', producer, 'push');
  assert.equal(sync().status, 'current'); assert.equal(fs.readFileSync(path.join(consumer, 'fact.md'), 'utf8'), 'two');
  fs.writeFileSync(path.join(consumer, 'fact.md'), 'local edit'); assert.equal(sync().code, 'DIRTY'); assert.equal(fs.readFileSync(path.join(consumer, 'fact.md'), 'utf8'), 'local edit');
  git('-C', consumer, 'commit', '-am', 'local'); fs.writeFileSync(path.join(producer, 'fact.md'), 'remote edit'); git('-C', producer, 'commit', '-am', 'remote'); git('-C', producer, 'push');
  assert.equal(sync().code, 'NOT_FAST_FORWARD'); assert.equal(fs.readFileSync(path.join(consumer, 'fact.md'), 'utf8'), 'local edit');
});
