import { fail } from './common.js';
// Import only the documented M1 subset. Unsupported TOML fails closed, never drops capabilities.
export function legacyConfig(text: string): Record<string, any> {
  const root: Record<string, any> = Object.create(null);
  let table = root;
  const bad = () => fail('UNSUPPORTED_LEGACY_CONFIG', '旧配置包含不支持或重复的 TOML 字段', '先为现有能力补充迁移 schema；不忽略未建模能力。');
  const sections = new WeakMap<object, Set<string>>();
  for (const raw of text.split(/\r?\n/)) {
    let line = '', quote = '', escaped = false;
    for (const char of raw) {
      if (!quote && char === '#') break;
      line += char;
      if (escaped) { escaped = false; continue; }
      if (quote === '"' && char === '\\') { escaped = true; continue; }
      if (quote && char === quote) quote = '';
      else if (!quote && (char === '"' || char === "'")) quote = char;
    }
    line = line.trim(); if (!line) continue;
    if (quote) bad();
    const header = /^(\[\[?)([a-z][a-z0-9_.]*)(\]\]?)$/.exec(line);
    if (header) {
      if (header[1]!.length !== header[3]!.length) bad();
      const parts = header[2]!.split('.'); let parent = root;
      for (const key of parts.slice(0, -1)) {
        if (['constructor', 'prototype', '__proto__'].includes(key)) bad();
        parent[key] ??= Object.create(null);
        const next = parent[key]; parent = Array.isArray(next) ? next.at(-1) : next;
        if (!parent || typeof parent !== 'object') bad();
      }
      const key = parts.at(-1)!;
      if (['constructor', 'prototype', '__proto__'].includes(key)) bad();
      if (header[1] === '[[') {
        parent[key] ??= []; if (!Array.isArray(parent[key])) bad();
        table = Object.create(null); parent[key].push(table);
      } else {
        const seen = sections.get(parent) ?? new Set<string>(); if (seen.has(key)) bad(); seen.add(key); sections.set(parent, seen);
        parent[key] ??= Object.create(null); table = parent[key];
        if (!table || typeof table !== 'object' || Array.isArray(table)) bad();
      }
      continue;
    }
    const assignment = /^([a-z][a-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    if (!assignment) bad();
    const [, key, rawValue] = assignment!;
    if (['constructor', 'prototype', '__proto__'].includes(key!) || Object.hasOwn(table, key!)) bad();
    let value: unknown;
    try {
      if (/^'[^']*'$/.test(rawValue!)) value = rawValue!.slice(1, -1);
      else value = JSON.parse(rawValue!);
    } catch { bad(); }
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isSafeInteger(value))) bad();
    table[key!] = value;
  }
  return root;
}
export function exactFields(value: any, fields: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) fail('UNSUPPORTED_LEGACY_CONFIG', '旧配置存在未建模能力', '补充对应 schema 后再接管；不会忽略字段。');
}
