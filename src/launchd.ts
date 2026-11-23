import { setTimeout as delay } from 'node:timers/promises';
import { fail } from './common.js';
import { run } from './doctor.js';

export function serviceAbsent(r: ReturnType<typeof run>, label: string): boolean {
  return r.status === 113 && (r.stderr ?? '').includes(`Could not find service "${label}" in domain for user gui: ${process.getuid!()}`);
}
export async function stop(label: string, system: { run: typeof run }) {
  const target = `gui/${process.getuid!()}/${label}`;
  system.run('launchctl', ['bootout', target]);
  for (let attempt = 0; attempt < 30; attempt++) {
    const r = system.run('launchctl', ['print', target]);
    if (serviceAbsent(r, label)) return;
    if (r.status !== 0) fail('SERVICE_STATE_UNKNOWN', '无法确认 launchd 服务状态', '检查 GUI 域与权限；恢复记录已保留，不能把查询失败当作已卸载。');
    await delay(300);
  }
  fail('STOP_UNVERIFIED', '未能确认旧服务已卸载，恢复记录已保留', '核对 launchd 后运行 anc rollback；不要删除恢复记录。');
}
export async function launch(label: string, plistPath: string, system: { run: typeof run }) {
  const target = `gui/${process.getuid!()}/${label}`;
  await stop(label, system);
  // bootout can return before launchd finishes removing the old registration.
  for (let attempt = 0; attempt < 30; attempt++) {
    const state = system.run('launchctl', ['print', target]);
    if (serviceAbsent(state, label) && system.run('launchctl', ['bootstrap', `gui/${process.getuid!()}`, plistPath]).status === 0) return;
    if (state.status !== 0 && !serviceAbsent(state, label)) fail('SERVICE_STATE_UNKNOWN', '无法确认 launchd 服务状态', '检查 GUI 域和权限后恢复事务。');
    await delay(300);
  }
  fail('BOOTSTRAP_FAILED', 'launchd 装载失败', '检查当前用户 GUI 会话及 plist。');
}
