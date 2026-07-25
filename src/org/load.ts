/**
 * load.ts —— 扫目录 → Org 对象(M1-DESIGN §3)。
 *
 * 本模块是 org 加载的 I/O 边界:读 company/ roles/ members/ 三处真相源,
 * 逐文件走 frontmatter → schema 校验,最后做 org 级引用完整性检查。
 * 任何一条 issue 都会让 org 为 undefined —— 坏 org 不进渲染管线。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter";
import {
  buildCompany,
  buildMember,
  buildRole,
  checkOrg,
  Company,
  DEVBOT_ROLE,
  Member,
  Org,
  Role,
  SchemaIssue,
} from "./schema";

export interface LoadResult {
  org?: Org;
  issues: SchemaIssue[];
}

function listSubdirs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

/** members 目录名排序 + devbot 殿后(输出确定性,diff 稳定;M1-DESIGN §4.1)。 */
export function orderMembers(members: Member[]): Member[] {
  const sorted = [...members].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [...sorted.filter((m) => m.role !== DEVBOT_ROLE), ...sorted.filter((m) => m.role === DEVBOT_ROLE)];
}

export function loadOrg(vaultRoot: string): LoadResult {
  const issues: SchemaIssue[] = [];

  // company
  const companyFile = path.join(vaultRoot, "company", "company.md");
  let company: Company | undefined;
  if (!fs.existsSync(companyFile)) {
    issues.push({ file: companyFile, message: "缺少 company/company.md(公司自描述,M1-DESIGN §3.2)" });
  } else {
    const fm = parseFrontmatter(fs.readFileSync(companyFile, "utf8"));
    const built = buildCompany(fm, companyFile);
    issues.push(...built.issues);
    company = built.value;
  }

  // roles
  const roles: Record<string, Role> = {};
  const rolesDir = path.join(vaultRoot, "roles");
  const roleDirs = listSubdirs(rolesDir);
  if (roleDirs.length === 0) {
    issues.push({ file: rolesDir, message: "roles/ 下没有任何角色目录(至少需要 devbot 与一个业务角色)" });
  }
  for (const dirName of roleDirs) {
    const file = path.join(rolesDir, dirName, "persona.md");
    if (!fs.existsSync(file)) {
      issues.push({ file, message: `roles/${dirName}/ 缺少 persona.md` });
      continue;
    }
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const built = buildRole(fm, file, dirName);
    issues.push(...built.issues);
    if (built.value) roles[built.value.role] = built.value;
  }

  // members
  const members: Member[] = [];
  const membersDir = path.join(vaultRoot, "members");
  const memberDirs = listSubdirs(membersDir);
  if (memberDirs.length === 0) {
    issues.push({ file: membersDir, message: "members/ 下没有任何成员目录" });
  }
  for (const dirName of memberDirs) {
    const file = path.join(membersDir, dirName, "persona.md");
    if (!fs.existsSync(file)) {
      issues.push({ file, message: `members/${dirName}/ 缺少 persona.md` });
      continue;
    }
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    const built = buildMember(fm, file, dirName);
    issues.push(...built.issues);
    if (built.value) members.push(built.value);
  }

  // org 级校验只有在文件级全部通过时才有意义(避免噪音淹没根因)
  if (company && issues.length === 0) {
    issues.push(...checkOrg(company, roles, members));
  }

  if (!company || issues.length > 0) return { issues };
  return { org: { company, roles, members: orderMembers(members) }, issues };
}
