// Opt-in: creates one isolated LaunchAgent with a fake gateway and removes it in finally.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { init } from '../dist/init.js';
import { deploy, waitReady } from '../dist/deploy.js';
import { run } from '../dist/doctor.js';

test('real launchd install, failed update, verified rollback', { skip: process.platform !== 'darwin', timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-launchd-'));
  const companyId = `test-${Date.now()}`, label = `com.anc.${companyId}.gateway`;
  const opts = { dir: path.join(root, 'vault'), stateDir: path.join(root, 'state'), apply: true };
  try {
    init({ ...opts, identity: { companyId, companyName: 'Test Company', memberId: 'alice', memberName: 'Alice' } });
    const member = path.join(opts.dir, 'members/alice/persona.md');
    fs.writeFileSync(member, fs.readFileSync(member, 'utf8').replace('app_id: ""', `app_id: "${['cli', 'ancTestOnly'].join('_')}"`).replace('open_id: ""', `open_id: "${['ou', 'ancTestOnly'].join('_')}"`));
    fs.writeFileSync(path.join(opts.stateDir, 'secrets.env'), 'ANC_FEISHU_SECRET_ALICE=fixture-only\n');
    const gateway = path.join(root, 'mock-gateway');
    fs.writeFileSync(gateway, `#!${process.execPath}\nconsole.log('msg="platform ready" project=${companyId}-alice platform=feishu');console.log('[Info] [connected to wss://fixture.invalid]');setInterval(()=>{},1000);`, { mode: 0o700 });
    const system = { launchAgentsDir: path.join(root, 'LaunchAgents'), locate: () => gateway, run, doctor: () => ({ status: 'ready-to-deploy', checks: [] }), sandboxProbe: () => {}, ready: (...args) => waitReady(...args, 15000) };
    assert.equal((await deploy(opts, system)).status, 'deployed');
    const persona = path.join(opts.stateDir, 'homes/alice/AGENTS.md'), previous = fs.readFileSync(persona, 'utf8');
    fs.appendFileSync(member, '\nChanged instruction');
    let attempt = 0;
    system.ready = (label, log, offset, projects) => waitReady(label, log, offset, ++attempt === 1 ? ['intentionally-missing-project'] : projects, attempt === 1 ? 4000 : 15000);
    await assert.rejects(deploy(opts, system), { code: 'ROLLED_BACK', exitCode: 3 });
    assert.equal(attempt, 2);
    assert.equal(fs.readFileSync(persona, 'utf8'), previous);
    assert.match(run('launchctl', ['print', `gui/${process.getuid()}/${label}`]).stdout, /state = running/);
  } finally {
    run('launchctl', ['bootout', `gui/${process.getuid()}/${label}`]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
