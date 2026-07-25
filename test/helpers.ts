/** 测试公共设施:fixture 路径、全管线组装、内存 org 工厂。 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadOrg } from "../src/org/load";
import { Company, Member, Org, parsePersonaBody, Role } from "../src/org/schema";
import { renderPersona } from "../src/render/persona";
import { buildRoutingTable, scanVaultDataDirs } from "../src/render/routing";
import { feishuSecretEnv, HostInputs, renderConfig, RenderedConfig } from "../src/render/toml";

/** 编译产物在 dist/test/,fixture 与模板取自仓库源路径。 */
export const REPO_ROOT = path.join(__dirname, "..", "..");
export const FIXTURES = path.join(REPO_ROOT, "test", "fixtures");
export const DEMO_VAULT = path.join(FIXTURES, "demo-vault");
export const GOLDEN_DIR = path.join(REPO_ROOT, "test", "golden");

export function baseTemplate(): string {
  return fs.readFileSync(path.join(REPO_ROOT, "templates", "persona-base.md"), "utf8");
}

export function gatewayExtraFixture(): string {
  return fs.readFileSync(path.join(FIXTURES, "gateway-extra.toml"), "utf8");
}

/** golden 用固定 host 输入:路径与真实机器无关,输出确定性。 */
export const GOLDEN_HOST: HostInputs = {
  vaultRoot: "/opt/anc-test/demo-vault",
  ancHome: "/opt/anc-test/dot-anc",
};
export const GOLDEN_VERSION = "0.0.0";
export const GOLDEN_NOW = "2026-01-01T00:00:00.000Z";

export function loadFixtureOrg(): Org {
  const result = loadOrg(DEMO_VAULT);
  assert.deepEqual(result.issues, [], "fixture org 应加载无误");
  assert.ok(result.org, "fixture org 应存在");
  return result.org;
}

/** 全管线:fixture org → personas → config.toml(与 W2 deploy config 同构)。 */
export function renderFixturePipeline(overrides?: { gatewayExtra?: string }): {
  org: Org;
  personas: Record<string, string>;
  rendered: RenderedConfig;
} {
  const org = loadFixtureOrg();
  const entries = scanVaultDataDirs(DEMO_VAULT);
  const base = baseTemplate();
  const personas: Record<string, string> = {};
  for (const member of org.members.filter((m) => !m.disabled)) {
    const role = org.roles[member.role];
    assert.ok(role, `角色 ${member.role} 应存在`);
    const routing = buildRoutingTable(entries, role.vault_scope, GOLDEN_HOST.vaultRoot);
    assert.deepEqual(routing.missingScopes, [], "fixture vault_scope 应全部命中");
    const res = renderPersona({
      baseTemplate: base,
      company: org.company,
      role,
      member,
      vaultRoot: GOLDEN_HOST.vaultRoot,
      ancHome: GOLDEN_HOST.ancHome,
      routingTable: routing.table,
    });
    assert.deepEqual(res.errors, [], `persona ${member.name} 应无 lint 错误`);
    personas[member.name] = res.text;
  }
  const rendered = renderConfig({
    org,
    personas,
    host: GOLDEN_HOST,
    ancVersion: GOLDEN_VERSION,
    now: GOLDEN_NOW,
    gatewayExtra: overrides?.gatewayExtra ?? gatewayExtraFixture(),
  });
  return { org, personas, rendered };
}

/** fixture 对应的 secrets.env 内容(全部占位值)。 */
export function fixtureSecrets(): Record<string, string> {
  return {
    ANC_FEISHU_SECRET_ALICE: "placeholder-a",
    ANC_FEISHU_SECRET_BOB: "placeholder-b",
    ANC_FEISHU_SECRET_DEVBOT: "placeholder-c",
    ANC_PROVIDER_KEY_CHEAPFALL: "placeholder-d",
    ANC_SPEECH_KEY: "placeholder-e",
  };
}

// ---------------------------------------------------------------------------
// 内存 org 工厂(负例/单元测试用,不落盘)
// ---------------------------------------------------------------------------

export function makeCompany(overrides?: Partial<Company>): Company {
  return {
    name: "Unit Test Co",
    id: "unit",
    language: "zh-CN",
    timezone: "Asia/Shanghai",
    platform: "feishu",
    defaults: { model: "claude-sonnet-5", mode: "dontAsk" },
    admins: ["alice"],
    sync_interval_min: 15,
    brief: "单元测试用公司。",
    briefStartLine: 12,
    file: "company/company.md",
    ...overrides,
  };
}

export function makeRole(name: string, overrides?: Partial<Role>): Role {
  const isDevbot = name === "devbot";
  const rawBody = "## 职责\n\n管单元测试。\n\n## 风格\n\n- 简洁。\n";
  return {
    role: name,
    title: isDevbot ? "开发运维" : "经理",
    model: "",
    mode: isDevbot ? "bypassPermissions" : "dontAsk",
    allowed_tools: isDevbot ? [] : ["Read", "Grep"],
    vault_scope: [],
    skills: [],
    body: parsePersonaBody(rawBody, 10),
    rawBody,
    bodyStartLine: 10,
    file: `roles/${name}/persona.md`,
    ...overrides,
  };
}

export function makeMember(name: string, roleName: string, overrides?: Partial<Member>): Member {
  const rawBody = "";
  return {
    name,
    display_name: `Member ${name}`,
    role: roleName,
    feishu: {
      app_id: `cli_***${name}`,
      open_id: `ou_***${name}`,
      extra_allow_from: [],
      allow_chat: [],
    },
    model: "",
    admin: false,
    disabled: false,
    body: parsePersonaBody(rawBody, 15),
    rawBody,
    bodyStartLine: 15,
    file: `members/${name}/persona.md`,
    ...overrides,
  };
}

/** 最小合法 org:alice(manager,admin)+ devbot。 */
export function makeOrg(overrides?: Partial<Org>): Org {
  return {
    company: makeCompany(),
    roles: { manager: makeRole("manager"), devbot: makeRole("devbot") },
    members: [makeMember("alice", "manager", { admin: true }), makeMember("devbot", "devbot")],
    ...overrides,
  };
}

/** 单元测试用平凡 personas(不过 persona.ts;toml/validate 只关心内容注入与 hash)。 */
export function trivialPersonas(org: Org): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of org.members.filter((mm) => !mm.disabled)) {
    out[m.name] = `测试 persona:${m.display_name}\n第二行。`;
  }
  return out;
}

/** org 对应的最小 secrets(feishu secret 全备)。 */
export function orgSecrets(org: Org): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of org.members.filter((mm) => !mm.disabled)) {
    out[feishuSecretEnv(m.name)] = "placeholder";
  }
  if (org.company.fallback_provider) {
    out[`ANC_PROVIDER_KEY_${org.company.fallback_provider.name.toUpperCase().replace(/-/g, "_")}`] = "placeholder";
  }
  return out;
}
