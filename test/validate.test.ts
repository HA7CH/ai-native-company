/**
 * validate.test.ts —— 三重校验的负例。
 *
 * 正例(fixture 全绿)由 config-golden.test.ts 覆盖;这里只管「该拦的拦不拦得住」。
 * 校验器是本设计的防线,防线的测试必须是负例 —— 全绿的正例证明不了任何拦截能力。
 *
 * SPEC §7 红线在此以可执行形式存在:bypass 仅 devbot、白名单无通配符、缺 secret 拒上线。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { renderConfig, RenderedConfig } from "../src/render/toml";
import { validateDiff, validateSemantic } from "../src/render/validate";
import { makeMember, makeOrg, makeRole, orgSecrets, trivialPersonas } from "./helpers";
import { Org } from "../src/org/schema";

const HOST = { vaultRoot: "/opt/anc-test/vault", ancHome: "/opt/anc-test/home" };

function render(org: Org): RenderedConfig {
  return renderConfig({
    org,
    personas: trivialPersonas(org),
    host: HOST,
    ancVersion: "0.0.0",
    now: "2026-01-01T00:00:00.000Z",
  });
}

/** 跑语义校验,返回命中的 rule 列表(顺序无关)。 */
function rules(org: Org, opts?: { secrets?: Record<string, string>; gatewayExtra?: string }): string[] {
  const rendered = render(org);
  return validateSemantic(rendered, {
    org,
    secrets: opts?.secrets ?? orgSecrets(org),
    gatewayExtra: opts?.gatewayExtra,
  }).map((i) => i.rule);
}

test("validate:基线 org 无 issue(负例测试的对照组)", () => {
  assert.deepEqual(rules(makeOrg()), []);
});

test("validate:SPEC §7 红线 —— 角色 bot 用 bypassPermissions 必被拦(无豁免开关)", () => {
  const org = makeOrg({
    roles: { manager: makeRole("manager", { mode: "bypassPermissions" }), devbot: makeRole("devbot") },
  });
  assert.ok(rules(org).includes("SEM-BYPASS"), "角色 bot 的 bypass 必须被拦下");

  // devbot 自己用 bypass 是唯一合法情形,不得误伤
  assert.ok(!rules(makeOrg()).includes("SEM-BYPASS"));
});

test("validate:SPEC §7 红线 —— allow_from 通配符必被拦", () => {
  const org = makeOrg({
    members: [
      makeMember("alice", "manager", {
        admin: true,
        feishu: { app_id: "cli_***a", open_id: "ou_***a", extra_allow_from: ["*"], allow_chat: [] },
      }),
      makeMember("devbot", "devbot"),
    ],
  });
  assert.ok(rules(org).includes("SEM-WILDCARD"), "通配符白名单等于对全员开放注册");
});

test("validate:SPEC §7 红线 —— 缺 secret / 空 secret 一律拒绝上线", () => {
  const org = makeOrg();
  const full = orgSecrets(org);

  const missing = { ...full };
  delete missing["ANC_FEISHU_SECRET_ALICE"];
  assert.ok(rules(org, { secrets: missing }).includes("SEM-SECRET"), "缺 secret 必须拦");

  const empty = { ...full, ANC_FEISHU_SECRET_ALICE: "   " };
  assert.ok(rules(org, { secrets: empty }).includes("SEM-SECRET"), "空 secret 会让全员同挂,必须拦");
});

test("validate:角色 bot 必须有非空 allowed_tools(不写该键语义为全开)", () => {
  const org = makeOrg({
    roles: { manager: makeRole("manager", { allowed_tools: [] }), devbot: makeRole("devbot") },
  });
  assert.ok(rules(org).includes("SEM-TOOLS"));
});

test("validate:open_id 形态与 app_id 唯一性", () => {
  const bad = makeOrg({
    members: [
      makeMember("alice", "manager", {
        admin: true,
        feishu: { app_id: "cli_***a", open_id: "not_an_open_id", extra_allow_from: [], allow_chat: [] },
      }),
      makeMember("devbot", "devbot"),
    ],
  });
  assert.ok(rules(bad).includes("SEM-OPENID"));

  const dup = makeOrg({
    members: [
      makeMember("alice", "manager", {
        admin: true,
        feishu: { app_id: "cli_***same", open_id: "ou_***a", extra_allow_from: [], allow_chat: [] },
      }),
      makeMember("bob", "manager", {
        feishu: { app_id: "cli_***same", open_id: "ou_***b", extra_allow_from: [], allow_chat: [] },
      }),
      makeMember("devbot", "devbot"),
    ],
  });
  assert.ok(rules(dup, { secrets: { ...orgSecrets(dup), ANC_FEISHU_SECRET_BOB: "x" } }).includes("SEM-APPID"));
});

test("validate:指纹头缺失必被拦", () => {
  const org = makeOrg();
  const rendered = render(org);
  const headless = { ...rendered, text: rendered.text.split("\n").slice(1).join("\n") };
  const hit = validateSemantic(headless, { org, secrets: orgSecrets(org) }).map((i) => i.rule);
  assert.ok(hit.includes("SEM-FINGERPRINT"));
});

test("validate:extra 段 secret 明文必被拦,非 ANC_ 变量给 WARN", () => {
  const org = makeOrg();
  const plaintext = rules(org, { gatewayExtra: '[speech]\napi_key = "sk-明文写死了"\n' });
  assert.ok(plaintext.includes("SEM-EXTRA-SECRET"), "extra 段无例外:secret 只许 ${ENV} 引用");

  const envRef = rules(org, { gatewayExtra: '[speech]\napi_key = "${ANC_SPEECH_KEY}"\n' });
  assert.ok(!envRef.includes("SEM-EXTRA-SECRET"), "${ANC_*} 引用形态应放行");

  const foreign = rules(org, { gatewayExtra: '[speech]\nendpoint = "${SOME_OTHER_VAR}"\n' });
  assert.ok(foreign.includes("SEM-EXTRA-ENV"), "非 ANC_ 变量不受 secrets 校验保护,应提示");
});

// ---------------------------------------------------------------------------
// 差分校验:接管闸与规模闸
// ---------------------------------------------------------------------------

test("validate:无指纹的现行 config 未给 --adopt 一律拒绝覆盖", () => {
  const rendered = render(makeOrg());
  const handWritten = '# 我手写的生产配置\nlanguage = "zh-CN"\n\n[[projects]]\nname = "legacy"\n';

  const refused = validateDiff(rendered, handWritten, { adopt: false, allowScale: false });
  assert.ok(refused.issues.some((i) => i.rule === "DIFF-ADOPT"), "疑似手写生产配置必须拒绝覆盖");

  const adopted = validateDiff(rendered, handWritten, { adopt: true, allowScale: true });
  assert.ok(!adopted.issues.some((i) => i.rule === "DIFF-ADOPT"), "--adopt 后放行");
});

test("validate:project 增删须显式 --allow-scale(误操作不得静默上下线 bot)", () => {
  const org = makeOrg();
  const current = render(org).text;

  const bigger = makeOrg({
    roles: { manager: makeRole("manager"), devbot: makeRole("devbot") },
    members: [
      makeMember("alice", "manager", { admin: true }),
      makeMember("carol", "manager"),
      makeMember("devbot", "devbot"),
    ],
  });
  const grown = render(bigger);

  const blocked = validateDiff(grown, current, { adopt: false, allowScale: false });
  assert.ok(blocked.issues.some((i) => i.rule === "DIFF-SCALE"), "新增 bot 必须显式放行");

  const allowed = validateDiff(grown, current, { adopt: false, allowScale: true });
  assert.deepEqual(allowed.issues, []);
  assert.ok(allowed.summary.some((s) => s.includes("unit-carol")), "摘要应列出新增的 project");
});

test("validate:首次部署与无变更各自给出可读摘要", () => {
  const org = makeOrg();
  const rendered = render(org);

  const first = validateDiff(rendered, null, { adopt: false, allowScale: false });
  assert.deepEqual(first.issues, []);
  assert.ok(first.summary[0]?.includes("首次部署"));

  const same = validateDiff(rendered, rendered.text, { adopt: false, allowScale: false });
  assert.deepEqual(same.issues, []);
  assert.deepEqual(same.summary, ["无变更(与现行 config 语义一致)"]);
});

test("validate:persona 与白名单变更进 diff 摘要(secret 已是 env 引用,可安全打印)", () => {
  const org = makeOrg();
  const current = render(org).text;

  const changed = makeOrg({
    members: [
      makeMember("alice", "manager", {
        admin: true,
        feishu: { app_id: "cli_***a", open_id: "ou_***a", extra_allow_from: ["ou_***newbie"], allow_chat: [] },
      }),
      makeMember("devbot", "devbot"),
    ],
  });
  const next = renderConfig({
    org: changed,
    personas: { ...trivialPersonas(changed), alice: "换了内容的 persona\n" },
    host: HOST,
    ancVersion: "0.0.0",
    now: "2026-01-01T00:00:00.000Z",
  });

  const result = validateDiff(next, current, { adopt: false, allowScale: false });
  const aliceLine = result.summary.find((s) => s.startsWith("~ project unit-alice"));
  assert.ok(aliceLine, "alice 应出现在变更摘要里");
  assert.match(aliceLine, /persona 变更/);
  assert.match(aliceLine, /allow_from/);
  assert.ok(!result.summary.join("\n").includes("placeholder"), "摘要不得泄露 secret 值");
});
