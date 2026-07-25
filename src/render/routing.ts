/**
 * routing.ts —— 扫 vault 数据目录生成 persona 路由表(M1-DESIGN §4.2,裁决 9)。
 *
 * 路由表由目录扫描生成而非手写:每个顶层数据目录取其 CLAUDE.md 首句为说明;
 * role.vault_scope 命中的行置顶并标「你的主力」。质量上限低于手写,但根治
 * 「persona 路由表与 vault 实况漂移」—— 压力给到 vault 数据纪律。
 *
 * buildRoutingTable 是纯函数;scanVaultDataDirs 是其 I/O 采集器(调用方注入结果)。
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface VaultDirEntry {
  name: string;
  description: string;
}

/** 非数据目录:org 真相源、模板、脚本、文档(M1-DESIGN §4.2) */
export const ROUTING_EXCLUDED_DIRS: readonly string[] = [
  "company",
  "roles",
  "members",
  "skills",
  "templates",
  "scripts",
  "docs",
  "node_modules",
];

export const NO_CLAUDE_MD_PLACEHOLDER = "(该目录暂无 CLAUDE.md 说明,请补目录级路由)";

/** 取目录 CLAUDE.md 的首句:第一个非空、非标题行,截到第一个「。」。 */
export function firstSentence(claudeMd: string): string {
  for (const rawLine of claudeMd.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const stripped = line.replace(/^[-*>]\s+/, "");
    const idx = stripped.indexOf("。");
    const sentence = idx >= 0 ? stripped.slice(0, idx + 1) : stripped;
    return sentence.length > 100 ? `${sentence.slice(0, 100)}…` : sentence;
  }
  return NO_CLAUDE_MD_PLACEHOLDER;
}

/** 扫 vault 顶层数据目录(排除 org/模板/脚本/文档与 `.`/`_` 前缀),按目录名排序。 */
export function scanVaultDataDirs(vaultRoot: string): VaultDirEntry[] {
  if (!fs.existsSync(vaultRoot)) return [];
  const entries: VaultDirEntry[] = [];
  const dirents = fs
    .readdirSync(vaultRoot, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() &&
        !d.name.startsWith(".") &&
        !d.name.startsWith("_") &&
        !ROUTING_EXCLUDED_DIRS.includes(d.name),
    )
    .map((d) => d.name)
    .sort();
  for (const name of dirents) {
    const claudeMd = path.join(vaultRoot, name, "CLAUDE.md");
    const description = fs.existsSync(claudeMd) ? firstSentence(fs.readFileSync(claudeMd, "utf8")) : NO_CLAUDE_MD_PLACEHOLDER;
    entries.push({ name, description });
  }
  return entries;
}

export interface RoutingTable {
  /** markdown 列表,渲染进 persona 段 3 的 {{routing_table}} 槽位 */
  table: string;
  /** vault_scope 声明了但 vault 里不存在的目录(调用方据此 WARN) */
  missingScopes: string[];
}

/** 生成路由表(纯函数)。vault_scope 命中的行置顶并标「你的主力」。 */
export function buildRoutingTable(entries: VaultDirEntry[], vaultScope: string[], vaultRoot: string): RoutingTable {
  const missingScopes: string[] = [];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const scopeEntries: VaultDirEntry[] = [];
  for (const scope of vaultScope) {
    const hit = byName.get(scope);
    if (hit) scopeEntries.push(hit);
    else missingScopes.push(scope);
  }
  const rest = entries.filter((e) => !vaultScope.includes(e.name));
  const lines: string[] = [];
  for (const e of scopeEntries) {
    lines.push(`- ${vaultRoot}/${e.name}/ —— ${e.description}【你的主力】`);
  }
  for (const e of rest) {
    lines.push(`- ${vaultRoot}/${e.name}/ —— ${e.description}`);
  }
  const table = lines.length > 0 ? lines.join("\n") : "(vault 暂无数据目录 —— 数据入库后重跑 anc deploy config 刷新路由表)";
  return { table, missingScopes };
}
