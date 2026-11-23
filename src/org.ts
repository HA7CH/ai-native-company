import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertTree, fail } from './common.js';

export type Value = string | boolean | number | string[] | { [key: string]: Value };
export interface Document { fields: Record<string, Value>; body: string }
// Deliberately small YAML subset: one nested mapping, JSON strings, scalars and flat arrays.
export function frontmatter(text: string, source: string): Document {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') fail('INVALID_ORG', `${source}: 缺少 frontmatter`, '以 --- 开始并结束元数据。');
  const end = lines.indexOf('---', 1);
  if (end < 0) fail('INVALID_ORG', `${source}: frontmatter 未结束`, '补上结束的 ---。');
  const fields: Record<string, Value> = Object.create(null);
  let parent: Record<string, Value> | undefined;
  for (let n = 1; n < end; n++) {
    const line = lines[n]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^( {0}| {2})([a-z][a-z0-9_]*):(?: +(.*))?$/.exec(line);
    const bad = () => fail('INVALID_ORG', `${source}:${n + 1}: 不支持或重复的 frontmatter 字段`, '仅支持标量、单层列表和一层嵌套映射；字符串用 JSON 双引号。');
    if (!m || ['__proto__', 'constructor', 'prototype'].includes(m[2]!)) bad();
    const [, indent, key, raw] = m!;
    const target = indent ? parent : fields;
    if (!target || Object.hasOwn(target, key!)) bad();
    if (raw === undefined) {
      if (indent) bad();
      parent = Object.create(null) as Record<string, Value>; fields[key!] = parent; continue;
    }
    if (!indent) parent = undefined;
    let value: Value;
    if (raw.startsWith('"')) {
      try { value = JSON.parse(raw); if (typeof value !== 'string') bad(); } catch { bad(); }
    } else if (raw.startsWith('[')) {
      if (!raw.endsWith(']')) bad();
      const inner = raw.slice(1, -1).trim();
      value = inner ? inner.split(',').map(s => {
        const v = s.trim();
        if (!/^[a-z][a-z0-9-]*$/.test(v)) bad();
        return v;
      }) : [];
    } else if (raw === 'true' || raw === 'false') value = raw === 'true';
    else if (/^\d+$/.test(raw)) value = Number(raw);
    else { if (!raw || /[&*!|>{}\[\]#\t]/.test(raw)) bad(); value = raw; }
    target![key!] = value!;
  }
  return { fields, body: lines.slice(end + 1).join('\n').trim() };
}
function shape(fields: Record<string, Value>, allowed: string[], source: string) {
  for (const key of Object.keys(fields)) if (!allowed.includes(key)) fail('UNKNOWN_ORG_FIELD', `${source}: 未知字段 ${key}`, '移除拼写错误或升级 schema；不会静默忽略。');
}
function string(value: Value | undefined, field: string, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) fail('INVALID_ORG', `${field} 必须是${empty ? '' : '非空'}字符串`, '核对 frontmatter 字段类型。');
  return value;
}
function map(value: Value | undefined, field: string): Record<string, Value> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ORG', `${field} 必须是映射`, '使用两个空格缩进下一层字段。');
  return value;
}
function id(value: Value | undefined, field: string): string {
  const s = string(value, field); if (!/^[a-z][a-z0-9-]{0,31}$/.test(s)) fail('INVALID_ORG', `${field} 不是合法 ID`, '使用小写 ASCII ID，长度不超过 32。'); return s;
}
export interface Member { id: string; name: string; role: string; policy: string; model: string; appId: string; openId: string; roleBody: string; body: string }
export interface Org { id: string; name: string; timezone: string; language: string; members: Member[]; missing: string[] }
export function loadOrg(vault: string): Org {
  const read = (p: string) => frontmatter(fs.readFileSync(assertTree(vault, p, 'file'), 'utf8'), p);
  const c = read('company/company.md').fields;
  shape(c, ['schema_version', 'id', 'name', 'timezone', 'language', 'platform', 'harness', 'defaults', 'admins', 'sync_enabled'], 'company');
  if (c.schema_version !== 1 || c.harness !== 'codex' || c.platform !== 'feishu') fail('UNSUPPORTED_ORG', '只支持 schema 1 / Codex / 飞书', '使用匹配的 org 定义。');
  const defaults = map(c.defaults, 'defaults'); shape(defaults, ['policy', 'model'], 'defaults');
  if (!Array.isArray(c.admins) || c.admins.length || c.sync_enabled !== false) fail('UNSUPPORTED_ORG', '首版暂不自动授权管理命令或启用远端同步', '保留 admins: [] 和 sync_enabled: false。');
  const result: Org = { id: id(c.id, 'company.id'), name: string(c.name, 'company.name'), timezone: string(c.timezone, 'timezone'), language: string(c.language, 'language'), members: [], missing: [] };
  new Intl.DateTimeFormat(result.language, { timeZone: result.timezone });
  const root = assertTree(vault, 'members', 'directory');
  const apps = new Set<string>(), users = new Set<string>();
  for (const memberId of fs.readdirSync(root).sort()) {
    id(memberId, 'member directory');
    const d = read(`members/${memberId}/persona.md`), m = d.fields;
    shape(m, ['name', 'display_name', 'role', 'feishu', 'model', 'disabled'], memberId);
    if (m.name !== memberId || typeof m.disabled !== 'boolean') fail('INVALID_ORG', `${memberId}: 目录名或 disabled 不合法`, '目录名必须等于 name；disabled 为 true/false。');
    if (m.disabled) continue;
    const roleId = id(m.role, `${memberId}.role`), r = read(`roles/${roleId}/persona.md`);
    shape(r.fields, ['role', 'title', 'policy', 'model', 'vault_scope', 'skills'], roleId);
    if (r.fields.role !== roleId) fail('INVALID_ORG', '角色目录与 role 字段不一致', '修正角色 ID。');
    const policy = string(r.fields.policy ?? defaults.policy, 'policy');
    if (!['readonly', 'workspace'].includes(policy)) fail('UNSUPPORTED_POLICY', `${memberId}: 不支持此权限策略`, '首版不启用 full；普通角色必须使用 readonly/workspace。');
    for (const key of ['vault_scope', 'skills']) if (!Array.isArray(r.fields[key])) fail('INVALID_ORG', `${roleId}.${key} 必须是列表`, '使用 [name] 或 []。');
    if ((r.fields.skills as string[]).length) fail('UNSUPPORTED_SKILLS', '尚未部署的技能不能默认为生效', '先清空 skills；后续使用专门的技能部署管线。');
    const f = map(m.feishu, 'feishu'); shape(f, ['app_id', 'open_id'], `${memberId}.feishu`);
    const appId = string(f.app_id, 'app_id', true), openId = string(f.open_id, 'open_id', true);
    for (const [label, value, pattern, seen] of [['app_id', appId, /^cli_[a-zA-Z0-9]+$/, apps], ['open_id', openId, /^ou_[a-zA-Z0-9]+$/, users]] as const) {
      if (!value) result.missing.push(`${memberId}.${label}`);
      else {
        if (!pattern.test(value) || seen.has(value)) fail('INVALID_BINDING', `${memberId}.${label} 非法或重复`, '核对本人账号和每成员独立飞书应用。');
        seen.add(value);
      }
    }
    result.members.push({ id: memberId, name: string(m.display_name, 'display_name'), role: roleId, policy, model: string(m.model, 'model', true) || string(r.fields.model, 'role.model', true) || string(defaults.model, 'defaults.model', true), appId, openId, roleBody: r.body, body: d.body });
  }
  if (!result.members.length) fail('NO_MEMBERS', '没有启用成员', '至少启用一位真人成员。');
  return result;
}
export function readSecrets(file: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [n, line] of fs.readFileSync(file, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const m = /^(ANC_FEISHU_SECRET_[A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m || Object.hasOwn(result, m[1]!)) fail('INVALID_SECRETS', `secrets.env 第 ${n + 1} 行不合法`, '使用唯一的 ANC_FEISHU_SECRET_<MEMBER>=值；不支持 shell 语法。');
    let value = m[2]!;
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { fail('INVALID_SECRETS', 'secret 引号格式不合法', '使用 JSON 双引号或原始单行值。'); } }
    if (typeof value !== 'string' || /[\r\n\x00]/.test(value) || /\$\{|\$\(|`/.test(value)) fail('INVALID_SECRETS', 'secret 包含不支持的表达式', '仅填写原始单行 secret，不使用变量或命令展开。');
    result[m[1]!] = value;
  }
  return result;
}
export const secretName = (id: string): string => `ANC_FEISHU_SECRET_${id.toUpperCase().replaceAll('-', '_')}`;
