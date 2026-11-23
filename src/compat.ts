import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fail } from './common.js';
import { codexEnvironment } from './codex-runner.js';

export function assertNamedPermissions(start: unknown, resume: unknown): void {
  for (const schema of [start, resume]) {
    if (!schema || typeof schema !== 'object' || !('properties' in schema) || !schema.properties || typeof schema.properties !== 'object' || !('permissions' in schema.properties)) {
      fail('INCOMPATIBLE_CODEX', '此 Codex 的 exec 协议不能完整传递命名权限策略', '安装已通过契约测试的官方 CLI；不能用旧协议的宽读取模式代替。');
    }
  }
}
export function verifyCodexProtocol(codex: string): void {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'anc-protocol-'));
  try {
    const r = spawnSync(codex, ['app-server', 'generate-json-schema', '--experimental', '--out', temp], { encoding: 'utf8', timeout: 15000, env: codexEnvironment(process.env), maxBuffer: 1024 * 1024 });
    if (r.status !== 0) fail('INCOMPATIBLE_CODEX', '无法核验 Codex 权限协议', '安装支持协议 schema 导出的官方 CLI。');
    assertNamedPermissions(JSON.parse(fs.readFileSync(path.join(temp, 'v2/ThreadStartParams.json'), 'utf8')), JSON.parse(fs.readFileSync(path.join(temp, 'v2/ThreadResumeParams.json'), 'utf8')));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
