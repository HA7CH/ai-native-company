import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parsePersonaBody } from "../src/org/schema";
import { renderPersona, PersonaContext } from "../src/render/persona";
import { buildRoutingTable } from "../src/render/routing";
import { baseTemplate, makeCompany, makeMember, makeRole } from "./helpers";

const VAULT_ROOT = "/opt/anc-test/demo-vault";
const ANC_HOME = "/opt/anc-test/dot-anc";

function ctx(overrides?: Partial<PersonaContext>): PersonaContext {
  return {
    baseTemplate: baseTemplate(),
    company: makeCompany(),
    role: makeRole("manager"),
    member: makeMember("alice", "manager", { admin: true }),
    vaultRoot: VAULT_ROOT,
    ancHome: ANC_HOME,
    routingTable: buildRoutingTable(
      [
        { name: "clients", description: "客户档案。" },
        { name: "projects", description: "项目档案。" },
      ],
      ["projects"],
      VAULT_ROOT,
    ).table,
    ...overrides,
  };
}

function withBody(name: "role" | "member", rawBody: string): Partial<PersonaContext> {
  if (name === "role") {
    return { role: makeRole("manager", { rawBody, body: parsePersonaBody(rawBody, 10) }) };
  }
  return { member: makeMember("alice", "manager", { admin: true, rawBody, body: parsePersonaBody(rawBody, 15) }) };
}

test("persona:七段有序 + 槽位替换 + 主力目录置顶", () => {
  const r = renderPersona(ctx());
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  const headings = [...r.text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(headings, ["身份", "职责", "数据来源", "诚实条款", "风格", "收资料 SOP", "动态事实"]);
  assert.match(r.text, /你是 Unit Test Co 的经理助理,专属服务 Member alice/);
  assert.match(r.text, /通过飞书机器人/);
  assert.match(r.text, /单元测试用公司。/); // company_brief
  assert.match(r.text, /公司时区:Asia\/Shanghai/);
  assert.ok(r.text.includes(`${VAULT_ROOT}/projects/ —— 项目档案。【你的主力】`));
  assert.ok(r.text.includes(`${VAULT_ROOT}/clients/ —— 客户档案。`));
  // 路由表里主力行在前
  assert.ok(r.text.indexOf("projects/") < r.text.indexOf("clients/"));
  assert.ok(!r.text.includes("{{"));
  assert.ok(r.text.endsWith("\n"));
});

test("persona:role 段落进入产物;member 末段「服务对象」", () => {
  const r = renderPersona(
    ctx(withBody("member", "称呼:阿姐;只说中文。\n\n## 风格\n\n- 补充:多用表格。")),
  );
  assert.deepEqual(r.errors, []);
  assert.match(r.text, /## 职责\n\n管单元测试。/); // role 职责追加进 base 空段
  assert.match(r.text, /## 风格\n\n- 简洁。\n\n- 补充:多用表格。/); // member 层默认追加
  assert.match(r.text, /## 服务对象\n\n称呼:阿姐;只说中文。\n$/);
});

test("persona:anc:replace 段级替换(member 替换 role 的风格)", () => {
  const r = renderPersona(
    ctx(withBody("member", "## 风格\n\n<!-- anc:replace -->\n- 只要一句话。")),
  );
  assert.deepEqual(r.errors, []);
  assert.match(r.text, /## 风格\n\n- 只要一句话。/);
  assert.ok(!r.text.includes("- 简洁。"), "被替换的 role 风格不应残留");
});

test("persona:术语表并入风格段(### 术语表)", () => {
  const roleBody = "## 职责\n\n管。\n\n## 风格\n\n- 简洁。\n\n## 术语表\n\n- SKU 保留英文。";
  const r = renderPersona(ctx(withBody("role", roleBody)));
  assert.deepEqual(r.errors, []);
  assert.match(r.text, /## 风格\n\n- 简洁。\n\n### 术语表\n\n- SKU 保留英文。/);
});

test("persona:lint FAIL —— {{ 槽位残留(未知槽位)", () => {
  const base = baseTemplate().replace("{{company_name}}", "{{no_such_slot}}");
  const r = renderPersona(ctx({ baseTemplate: base }));
  assert.ok(r.errors.some((e) => e.message.includes("{{no_such_slot}}")));
});

test("persona:lint FAIL —— 作者层 {{ 也算残留", () => {
  const r = renderPersona(ctx(withBody("member", "我想写 {{display_name}} 这种槽位。")));
  assert.ok(r.errors.some((e) => e.message.includes("残留")));
});

test("persona:lint FAIL —— ''' 拒渲,报来源层与行号", () => {
  const r = renderPersona(ctx(withBody("role", "## 职责\n\n管。\n\n## 风格\n\n- 引用 ''' 三引号。")));
  const hit = r.errors.find((e) => e.message.includes("'''"));
  assert.ok(hit, "应有 ''' 错误");
  assert.equal(hit.source, "roles/manager/persona.md");
  assert.equal(hit.line, 16); // bodyStartLine 10 + 第 7 行(0 起 6)
});

test("persona:lint FAIL —— ${ 拒渲,报来源层与行号", () => {
  const r = renderPersona(ctx(withBody("member", "第一行\n提到 ${HOME} 变量。")));
  const hit = r.errors.find((e) => e.message.includes("${"));
  assert.ok(hit, "应有 ${ 错误");
  assert.equal(hit.source, "members/alice/persona.md");
  assert.equal(hit.line, 16); // bodyStartLine 15 + 1
});

test("persona:lint WARN —— vault_root/homes 之外的绝对路径", () => {
  const r = renderPersona(ctx(withBody("role", "## 职责\n\n管;数据在 /etc/passwd 里。\n\n## 风格\n\n- 简。")));
  const hit = r.warnings.find((w) => w.message.includes("/etc/passwd"));
  assert.ok(hit, "应有绝对路径 WARN");
  assert.equal(hit.level, "WARN");
  assert.deepEqual(r.errors, []);
});

test("persona:lint —— vault_root 与 ~/.anc 路径不告警", () => {
  const body = `## 职责\n\n看 ${VAULT_ROOT}/projects/ 与 ~/.anc/homes/alice/。\n\n## 风格\n\n- 简。`;
  const r = renderPersona(ctx(withBody("role", body)));
  assert.deepEqual(r.warnings, []);
});

test("persona:lint WARN —— 「当前仅有 / 目前只有」句式", () => {
  const r = renderPersona(ctx(withBody("member", "目前只有两个客户。")));
  assert.ok(r.warnings.some((w) => w.message.includes("当前仅有")));
});

test("persona:base 缺必需段拒渲", () => {
  const base = baseTemplate().replace("## 诚实条款", "## 诚实备注");
  const r = renderPersona(ctx({ baseTemplate: base }));
  assert.ok(r.errors.some((e) => e.message.includes("缺少必需段 `## 诚实条款`")));
});

test("persona:转义用例 —— 中文/emoji/引号/裸换行原样通过", () => {
  const body = '称呼:小 A 😀;喜欢 "直接引用" 与反斜杠 \\ 混排。\n第二行裸换行。';
  const r = renderPersona(ctx(withBody("member", body)));
  assert.deepEqual(r.errors, []);
  assert.match(r.text, /## 服务对象\n\n称呼:小 A 😀;喜欢 "直接引用" 与反斜杠 \\ 混排。\n第二行裸换行。/);
});
