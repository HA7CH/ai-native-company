import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter } from "../src/org/frontmatter";
import {
  buildCompany,
  buildMember,
  buildRole,
  checkBodySections,
  checkOrg,
  parsePersonaBody,
  SchemaIssue,
} from "../src/org/schema";
import { makeCompany, makeMember, makeOrg } from "./helpers";

function messages(issues: SchemaIssue[]): string {
  return issues.map((i) => i.message).join("\n");
}

// ---------------------------------------------------------------------------
// company
// ---------------------------------------------------------------------------

const COMPANY_OK = `---
name: Demo Trading Co
id: demo
language: zh-CN
timezone: Asia/Shanghai
platform: feishu
defaults:
  model: claude-sonnet-5
  mode: dontAsk
  auto_compress_max_tokens: 120000
admins: [alice]
sync_interval_min: 15
---
一句话业务简介。`;

test("schema:company 正例(含可选段全缺省形态)", () => {
  const built = buildCompany(parseFrontmatter(COMPANY_OK), "company.md");
  assert.deepEqual(built.issues, []);
  assert.ok(built.value);
  assert.equal(built.value.defaults.auto_compress_max_tokens, 120000);
  assert.equal(built.value.fallback_provider, undefined);
});

test("schema:fallback_provider 全空 = 缺省;半填报错;全填生效", () => {
  const empty = COMPANY_OK.replace(
    "sync_interval_min: 15",
    'sync_interval_min: 15\nfallback_provider:\n  name: ""\n  base_url: ""\n  model: ""',
  );
  const b1 = buildCompany(parseFrontmatter(empty), "company.md");
  assert.deepEqual(b1.issues, []);
  assert.equal(b1.value?.fallback_provider, undefined);

  const half = COMPANY_OK.replace(
    "sync_interval_min: 15",
    'sync_interval_min: 15\nfallback_provider:\n  name: ""\n  base_url: "https://x.example.com"\n  model: m',
  );
  const b2 = buildCompany(parseFrontmatter(half), "company.md");
  assert.match(messages(b2.issues), /fallback_provider.name/);

  const full = COMPANY_OK.replace(
    "sync_interval_min: 15",
    'sync_interval_min: 15\nfallback_provider:\n  name: cheapfall\n  base_url: "https://x.example.com"\n  model: m',
  );
  const b3 = buildCompany(parseFrontmatter(full), "company.md");
  assert.deepEqual(b3.issues, []);
  assert.equal(b3.value?.fallback_provider?.name, "cheapfall");
});

test("schema:company 负例逐条被拦", () => {
  const cases: { mutate: (s: string) => string; re: RegExp }[] = [
    { mutate: (s) => s.replace("name: Demo Trading Co\n", ""), re: /缺少必填字段 `name`/ },
    { mutate: (s) => s.replace("id: demo", "id: Demo"), re: /`id` 格式不合法/ },
    { mutate: (s) => s.replace("platform: feishu", "platform: dingtalk"), re: /v1 唯一取值为 "feishu"/ },
    { mutate: (s) => s.replace("mode: dontAsk", "mode: bypassPermissions"), re: /`defaults.mode` 不允许 bypassPermissions/ },
    { mutate: (s) => s.replace("mode: dontAsk", "mode: yolo"), re: /`defaults.mode` 须为/ },
    { mutate: (s) => s.replace("auto_compress_max_tokens: 120000", "auto_compress_max_tokens: 12.5"), re: /须为整数/ },
    { mutate: (s) => s.replace("auto_compress_max_tokens: 120000", "auto_compress_max_tokens: 0"), re: /须 ≥ 1/ },
    { mutate: (s) => s.replace("admins: [alice]", "admins: []"), re: /`admins` 不能为空数组/ },
    { mutate: (s) => s.replace("admins: [alice]", "admins: [Alice]"), re: /`admins` 元素格式不合法/ },
    { mutate: (s) => s.replace("sync_interval_min: 15\n", ""), re: /缺少必填字段 `sync_interval_min`/ },
    { mutate: (s) => s.replace("sync_interval_min: 15", "sync_interval_min: 0"), re: /须 ≥ 1/ },
    { mutate: (s) => s.replace("id: demo", "id: demo\nmystery: 1"), re: /未知字段 `mystery`/ },
    { mutate: (s) => s.replace("一句话业务简介。", ""), re: /正文.*不能为空/ },
  ];
  for (const c of cases) {
    const built = buildCompany(parseFrontmatter(c.mutate(COMPANY_OK)), "company.md");
    assert.equal(built.value, undefined, `应拒绝:${c.re}`);
    assert.match(messages(built.issues), c.re);
  }
});

// ---------------------------------------------------------------------------
// role
// ---------------------------------------------------------------------------

const ROLE_OK = `---
role: manager
title: 经理
model: ""
mode: dontAsk
allowed_tools: [Read, Grep]
vault_scope: [projects]
skills: [now]
---
## 职责

管项目。

## 风格

- 简洁。`;

test("schema:role 正例", () => {
  const built = buildRole(parseFrontmatter(ROLE_OK), "roles/manager/persona.md", "manager");
  assert.deepEqual(built.issues, []);
  assert.equal(built.value?.title, "经理");
});

test("schema:role 负例逐条被拦", () => {
  const cases: { mutate: (s: string) => string; dir?: string; re: RegExp }[] = [
    { mutate: (s) => s, dir: "boss", re: /须与目录名/ },
    { mutate: (s) => s.replace("title: 经理\n", ""), re: /缺少必填字段 `title`/ },
    { mutate: (s) => s.replace("mode: dontAsk", "mode: bypassPermissions"), re: /角色 bot 一律不授予 bypass/ },
    { mutate: (s) => s.replace("allowed_tools: [Read, Grep]", "allowed_tools: []"), re: /`allowed_tools` 不能为空/ },
    { mutate: (s) => s.replace("vault_scope: [projects]", "vault_scope: [../etc]"), re: /`vault_scope` 元素格式不合法/ },
    { mutate: (s) => s.replace("## 职责\n\n管项目。\n", ""), re: /缺少必需段 `## 职责`/ },
    { mutate: (s) => s.replace("## 风格", "## 数据来源"), re: /段落归属/ },
    { mutate: (s) => s.replace("## 风格", "## 随想"), re: /未知 H2 段/ },
    { mutate: (s) => s.replace("## 职责", "游离正文\n\n## 职责"), re: /不允许 H2 段之外的正文/ },
  ];
  for (const c of cases) {
    const built = buildRole(parseFrontmatter(c.mutate(ROLE_OK)), "roles/manager/persona.md", c.dir ?? "manager");
    assert.equal(built.value, undefined, `应拒绝:${c.re}`);
    assert.match(messages(built.issues), c.re);
  }
});

test("schema:devbot 特判(bypass 必须 + 工具全开)", () => {
  const DEVBOT_OK = ROLE_OK.replace("role: manager", "role: devbot")
    .replace("mode: dontAsk", "mode: bypassPermissions")
    .replace("allowed_tools: [Read, Grep]", "allowed_tools: []");
  const ok = buildRole(parseFrontmatter(DEVBOT_OK), "roles/devbot/persona.md", "devbot");
  assert.deepEqual(ok.issues, []);

  const wrongMode = buildRole(
    parseFrontmatter(DEVBOT_OK.replace("mode: bypassPermissions", "mode: dontAsk")),
    "roles/devbot/persona.md",
    "devbot",
  );
  assert.match(messages(wrongMode.issues), /devbot 角色的 `mode` 须为 bypassPermissions/);

  const wrongTools = buildRole(
    parseFrontmatter(DEVBOT_OK.replace("allowed_tools: []", "allowed_tools: [Read]")),
    "roles/devbot/persona.md",
    "devbot",
  );
  assert.match(messages(wrongTools.issues), /devbot 角色的 `allowed_tools` 须为 \[\]/);
});

// ---------------------------------------------------------------------------
// member
// ---------------------------------------------------------------------------

const MEMBER_OK = `---
name: alice
display_name: Alice Wang
role: manager
feishu:
  app_id: cli_***alice
  open_id: ou_***alice
  extra_allow_from: [ou_***assist]
  allow_chat: []
model: ""
admin: true
disabled: false
---
称呼:Alice 总。`;

test("schema:member 正例", () => {
  const built = buildMember(parseFrontmatter(MEMBER_OK), "members/alice/persona.md", "alice");
  assert.deepEqual(built.issues, []);
  assert.equal(built.value?.feishu.open_id, "ou_***alice");
  assert.equal(built.value?.body.preamble, "称呼:Alice 总。");
});

test("schema:member 负例逐条被拦", () => {
  const cases: { mutate: (s: string) => string; dir?: string; re: RegExp }[] = [
    { mutate: (s) => s, dir: "bob", re: /须与目录名/ },
    { mutate: (s) => s.replace("display_name: Alice Wang\n", ""), re: /缺少必填字段 `display_name`/ },
    { mutate: (s) => s.replace("app_id: cli_***alice", "app_id: app-123"), re: /`feishu.app_id` 格式不合法/ },
    { mutate: (s) => s.replace("open_id: ou_***alice", "open_id: xx_bad"), re: /`feishu.open_id` 格式不合法/ },
    { mutate: (s) => s.replace("extra_allow_from: [ou_***assist]", 'extra_allow_from: ["*"]'), re: /不允许通配符/ },
    { mutate: (s) => s.replace("extra_allow_from: [ou_***assist]", "extra_allow_from: [bob]"), re: /`feishu.extra_allow_from` 元素格式不合法/ },
    { mutate: (s) => s.replace("allow_chat: []", 'allow_chat: ["*"]'), re: /不允许通配符/ },
    { mutate: (s) => s.replace("admin: true", "admin: yes"), re: /须为 true\/false/ },
    { mutate: (s) => s.replace("  open_id: ou_***alice", "  open_id: ou_***alice\n  wechat_id: w"), re: /未知字段 `feishu.wechat_id`/ },
    { mutate: (s) => s.replace("称呼:Alice 总。", "## 诚实条款\n\n私改。"), re: /段落归属/ },
  ];
  for (const c of cases) {
    const built = buildMember(parseFrontmatter(c.mutate(MEMBER_OK)), "members/alice/persona.md", c.dir ?? "alice");
    assert.equal(built.value, undefined, `应拒绝:${c.re}`);
    assert.match(messages(built.issues), c.re);
  }
});

// ---------------------------------------------------------------------------
// body 段解析 + org 级校验
// ---------------------------------------------------------------------------

test("schema:parsePersonaBody 解析 H2/anc:replace/行号", () => {
  const body = "前言两行\n第二行\n\n## 风格\n\n<!-- anc:replace -->\n- 替换后内容。\n\n## 术语表\n\n- SKU。";
  const parsed = parsePersonaBody(body, 15);
  assert.equal(parsed.preamble, "前言两行\n第二行");
  assert.equal(parsed.sections.length, 2);
  assert.deepEqual(
    parsed.sections.map((s) => [s.name, s.replace]),
    [
      ["风格", true],
      ["术语表", false],
    ],
  );
  assert.equal(parsed.sections[0]?.content, "- 替换后内容。");
  assert.equal(parsed.sections[0]?.line, 18); // body 第 4 行,startLine 15
});

test("schema:member body 重复段报错", () => {
  const parsed = parsePersonaBody("## 风格\n\n- a\n\n## 风格\n\n- b", 1);
  const issues = checkBodySections(parsed, "member", "members/x/persona.md");
  assert.match(messages(issues), /重复的段/);
});

test("schema:checkOrg 引用完整性与唯一性负例", () => {
  // 引用不存在的角色
  const badRole = makeOrg({ members: [makeMember("alice", "ghost", { admin: true }), makeMember("devbot", "devbot")] });
  assert.match(messages(checkOrg(badRole.company, badRole.roles, badRole.members)), /不存在的角色 `ghost`/);

  // admins 指向不存在成员
  const badAdmin = makeOrg({ company: makeCompany({ admins: ["ghost"] }) });
  const badAdminIssues = checkOrg(badAdmin.company, badAdmin.roles, badAdmin.members);
  assert.match(messages(badAdminIssues), /admins 引用了不存在的 member `ghost`/);

  // admins 指向停用成员
  const disabledAdmin = makeOrg({
    members: [makeMember("alice", "manager", { admin: true, disabled: true }), makeMember("devbot", "devbot")],
  });
  assert.match(messages(checkOrg(disabledAdmin.company, disabledAdmin.roles, disabledAdmin.members)), /已停用/);

  // admin 标记与 company.admins 不一致
  const flagMismatch = makeOrg({
    members: [makeMember("alice", "manager", { admin: false }), makeMember("devbot", "devbot")],
  });
  assert.match(messages(checkOrg(flagMismatch.company, flagMismatch.roles, flagMismatch.members)), /admin 标记.*不一致/);

  // devbot 数量:0 与 2
  const noDevbot = makeOrg({ members: [makeMember("alice", "manager", { admin: true })] });
  assert.match(messages(checkOrg(noDevbot.company, noDevbot.roles, noDevbot.members)), /当前 0 个/);
  const twoDevbots = makeOrg({
    members: [
      makeMember("alice", "manager", { admin: true }),
      makeMember("devbot", "devbot"),
      makeMember("devbot2", "devbot"),
    ],
  });
  assert.match(messages(checkOrg(twoDevbots.company, twoDevbots.roles, twoDevbots.members)), /当前 2 个/);

  // app_id 在启用成员间重复
  const dupApp = makeOrg({
    members: [
      makeMember("alice", "manager", { admin: true }),
      makeMember("devbot", "devbot", { feishu: { app_id: "cli_***alice", open_id: "ou_***founder", extra_allow_from: [], allow_chat: [] } }),
    ],
  });
  assert.match(messages(checkOrg(dupApp.company, dupApp.roles, dupApp.members)), /app_id `cli_\*\*\*alice` .*重复/);

  // 停用成员不参与 app_id 唯一性
  const dupWithDisabled = makeOrg({
    members: [
      makeMember("alice", "manager", { admin: true }),
      makeMember("old", "manager", { disabled: true, feishu: { app_id: "cli_***alice", open_id: "ou_***old", extra_allow_from: [], allow_chat: [] } }),
      makeMember("devbot", "devbot"),
    ],
  });
  assert.deepEqual(checkOrg(dupWithDisabled.company, dupWithDisabled.roles, dupWithDisabled.members), []);
});
