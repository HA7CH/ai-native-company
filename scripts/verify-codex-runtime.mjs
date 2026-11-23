// Opt-in integration test: uses the logged-in official CLI and consumes model tokens.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { guardedArgs, codexEnvironment } from '../dist/codex-runner.js';
import { locate, run } from '../dist/doctor.js';
import { verifyCodexProtocol } from '../dist/compat.js';
import { shellQuote } from '../dist/render.js';
const codex = process.env.ANC_CODEX_BIN || locate('codex');
assert(codex, 'Set ANC_CODEX_BIN to the official CLI executable');
verifyCodexProtocol(codex);
console.log(run(codex, ['--version']).stdout.trim());
// Do not use system temp: Codex may grant OS scratch directories baseline access.
const root = fs.mkdtempSync(path.join(os.homedir(), '.anc-contract-test-'));
async function call(home, policy, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(codex, guardedArgs(args, policy), { cwd: home, env: codexEnvironment(process.env), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', b => { output += b; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => {
      clearTimeout(timer);
      const events = output.split('\n').flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } });
      const actual = events.filter(e => e.type === 'item.completed' && e.item?.type === 'command_execution').map(e => e.item.aggregated_output).join('\n');
      try {
        assert.equal(code, 0, 'Official CLI call failed');
        for (const text of ['ANC_VAULT_FACT_42', 'READ_DENIED', 'WRITE_DENIED']) assert(actual.includes(text), `Missing actual tool evidence: ${text}`);
        assert(!actual.includes('LEAK'), 'Tool escaped the declared policy');
        assert(actual.includes(policy[home] === 'write' ? 'HOME_WRITE' : 'HOME_DENIED'));
        resolve(events.find(e => e.type === 'thread.started')?.thread_id);
      } catch (e) { reject(e); }
    });
  });
}
try {
  for (const mode of ['read', 'write']) {
    const home = path.join(root, mode), knowledge = path.join(root, `${mode}-knowledge`), hidden = path.join(root, `${mode}-private`);
    for (const p of [home, knowledge, hidden]) fs.mkdirSync(p, { mode: 0o700 });
    fs.writeFileSync(path.join(home, '.anc-bot-root'), '');
    fs.writeFileSync(path.join(home, 'AGENTS.md'), 'You are a deployment test bot. Only execute the requested shell command; do not use external apps.');
    fs.writeFileSync(path.join(knowledge, 'fact'), 'ANC_VAULT_FACT_42\n');
    fs.writeFileSync(path.join(hidden, 'sentinel'), 'DUMMY_ONLY');
    const command = `cat ${shellQuote(path.join(knowledge, 'fact'))}; if cat ${shellQuote(path.join(hidden, 'sentinel'))} >/dev/null 2>&1; then echo READ_LEAK; else echo READ_DENIED; fi; if touch ${shellQuote(path.join(knowledge, 'write-test'))} 2>/dev/null; then echo WRITE_LEAK; else echo WRITE_DENIED; fi; if touch ${shellQuote(path.join(home, 'write-test'))} 2>/dev/null; then echo HOME_WRITE; else echo HOME_DENIED; fi`;
    const prompt = `Run exactly this shell command once and report its output. Do not do other work.\n${command}`;
    const policy = { ':root': 'deny', ':minimal': 'read', [home]: mode, [knowledge]: 'read' };
    const id = await call(home, policy, ['exec', '--skip-git-repo-check', '--json', prompt]);
    assert(id, 'Missing thread identity');
    await call(home, policy, ['exec', 'resume', '--skip-git-repo-check', id, '--json', prompt]);
    assert(!fs.existsSync(path.join(knowledge, 'write-test')));
    console.log(`PASS ${mode}: first exec + resume; knowledge readable, sibling denied, writes scoped`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
