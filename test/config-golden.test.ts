/**
 * config-golden.test.ts —— 全量 config.toml 的黄金快照 + M1-DESIGN §4.1/§4.3 结构断言。
 *
 * 快照钉的是「渲染器产出的确切字节」:渲染逻辑任何无意改动都会在 diff 里现形。
 * 有意改动时用 `UPDATE_GOLDEN=1 npm test` 重生成,并在 PR 里逐行 review 快照 diff ——
 * 快照的价值全在「改动必须被看见」,不看 diff 直接重生成等于把这道防线关掉。
 *
 * 结构断言与快照互补:快照抓「变了」,断言抓「为什么不能变」(裁决与红线的可执行形式)。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { FINGERPRINT_RE, parseAncToml, renderConfig } from "../src/render/toml";
import { validateRoundTrip, validateSemantic } from "../src/render/validate";
import {
  fixtureSecrets,
  gatewayExtraFixture,
  GOLDEN_DIR,
  GOLDEN_HOST,
  GOLDEN_NOW,
  GOLDEN_VERSION,
  renderFixturePipeline,
} from "./helpers";

const GOLDEN_CONFIG = path.join(GOLDEN_DIR, "config.toml");

test("golden:config.toml 全量快照", () => {
  const { rendered } = renderFixturePipeline();
  if (process.env["UPDATE_GOLDEN"] === "1") {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    fs.writeFileSync(GOLDEN_CONFIG, rendered.text, "utf8");
  }
  assert.ok(
    fs.existsSync(GOLDEN_CONFIG),
    `缺 golden 快照 ${GOLDEN_CONFIG} —— 用 UPDATE_GOLDEN=1 npm test 生成`,
  );
  assert.equal(rendered.text, fs.readFileSync(GOLDEN_CONFIG, "utf8"), "config.toml 与 golden 快照不一致");
});

test("golden:渲染确定性 —— 同输入逐字节同产出", () => {
  const a = renderFixturePipeline().rendered;
  const b = renderFixturePipeline().rendered;
  assert.equal(a.text, b.text);
  assert.equal(a.inputsHash, b.inputsHash);
  assert.deepEqual(a.projectNames, b.projectNames);
});

test("golden:指纹 inputs 覆盖主机层与 extra —— 只改主机输入也触发重渲染", () => {
  const base = renderFixturePipeline().rendered;
  assert.match(base.text.split("\n")[0] as string, FINGERPRINT_RE);

  // 仅改 gateway-extra:指纹必须变(否则「org 未变」会短路漏掉主机层改动)
  const extraChanged = renderFixturePipeline({ gatewayExtra: "# 改了一行\n" }).rendered;
  assert.notEqual(extraChanged.inputsHash, base.inputsHash, "gateway-extra 变化必须进指纹");

  // 仅改 host 路径:指纹必须变
  const { org, personas } = renderFixturePipeline();
  const hostChanged = renderConfig({
    org,
    personas,
    host: { ...GOLDEN_HOST, ancHome: "/opt/anc-test/other-home" },
    ancVersion: GOLDEN_VERSION,
    now: GOLDEN_NOW,
    gatewayExtra: gatewayExtraFixture(),
  });
  assert.notEqual(hostChanged.inputsHash, base.inputsHash, "host 路径变化必须进指纹");

  // 仅改 now:指纹不该变(时间戳不是输入,否则每次部署都判定为「有变更」)
  const laterNow = renderConfig({
    org,
    personas,
    host: GOLDEN_HOST,
    ancVersion: GOLDEN_VERSION,
    now: "2026-12-31T23:59:59.000Z",
    gatewayExtra: gatewayExtraFixture(),
  });
  assert.equal(laterNow.inputsHash, base.inputsHash, "时间戳不应进指纹");
});

test("golden:admin_from 在 project 顶层,绝不在 platforms.options(上游会静默忽略)", () => {
  const { rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  assert.equal(parsed.projects.length, 3);
  for (const p of parsed.projects) {
    assert.equal(typeof p.top["admin_from"], "string", "admin_from 必须在 project 顶层");
    for (const platform of p.platforms) {
      assert.ok(!("admin_from" in platform.options), "admin_from 不得出现在 platforms.options");
    }
  }
});

test("golden:secret 一律 ${ENV} 引用,配置里不出现明文", () => {
  const { rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  for (const p of parsed.projects) {
    for (const platform of p.platforms) {
      assert.match(platform.options["app_secret"] as string, /^\$\{ANC_FEISHU_SECRET_[A-Z0-9_]+\}$/);
    }
    for (const provider of p.providers) {
      assert.match(provider["api_key"] as string, /^\$\{ANC_PROVIDER_KEY_[A-Z0-9_]+\}$/);
    }
  }
  // fixture 的占位 secret 值不得出现在 config 文本里
  for (const value of Object.values(fixtureSecrets())) {
    assert.ok(!rendered.text.includes(value), `config 不得含 secret 明文:${value}`);
  }
});

test("golden:devbot 特判 —— work_dir 为 vault 根、无 allowed_tools;角色 bot 反之", () => {
  const { rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  const byName = new Map(parsed.projects.map((p) => [p.top["name"] as string, p]));

  const devbot = byName.get("demo-devbot");
  assert.ok(devbot, "应有 demo-devbot project");
  assert.equal(devbot.options["work_dir"], GOLDEN_HOST.vaultRoot, "devbot 的 cwd 是 vault 根");
  assert.ok(!("allowed_tools" in devbot.options), "devbot 不写 allowed_tools(语义为全开)");

  for (const name of ["demo-alice", "demo-bob"]) {
    const p = byName.get(name);
    assert.ok(p, `应有 ${name} project`);
    assert.equal(p.options["work_dir"], `${GOLDEN_HOST.ancHome}/homes/${name.slice("demo-".length)}`);
    assert.notEqual(p.options["mode"], "bypassPermissions", "角色 bot 一律不授予 bypass(SPEC §7 红线)");
    assert.ok(Array.isArray(p.options["allowed_tools"]), "角色 bot 必须有 allowed_tools 白名单");
    assert.ok((p.options["allowed_tools"] as string[]).length > 0, "allowed_tools 不得为空");
  }
});

test("golden:allow_from 去重且含本人与全部 admin", () => {
  const { org, rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  const adminIds = org.company.admins.map((a) => org.members.find((m) => m.name === a)?.feishu.open_id);
  for (const p of parsed.projects) {
    for (const platform of p.platforms) {
      const allow = platform.options["allow_from"] as string[];
      assert.deepEqual(allow, [...new Set(allow)], "allow_from 必须去重");
      for (const admin of adminIds) assert.ok(allow.includes(admin as string), "allow_from 必须含全部 admin");
      assert.ok(!allow.includes("*"), "allow_from 不得含通配符");
    }
  }
});

test("golden:gateway-extra 原样并入且被标记段包裹", () => {
  const { rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  assert.equal(parsed.extraRaw, gatewayExtraFixture().replace(/\n+$/, ""), "extra 段应原样并入");
  assert.ok(rendered.text.includes("# anc:extra-begin"), "应有 extra 起始标记");
  assert.ok(rendered.text.includes("# anc:extra-end"), "应有 extra 结束标记");

  // 无 extra 时不留空段
  const noExtra = renderFixturePipeline({ gatewayExtra: "" }).rendered;
  assert.ok(!noExtra.text.includes("# anc:extra-begin"), "无 extra 时不应出现标记段");
});

test("golden:auto_compress 为可选段 —— 未配置则整段不渲染", () => {
  const { org, personas } = renderFixturePipeline();
  const withAC = renderConfig({
    org,
    personas,
    host: GOLDEN_HOST,
    ancVersion: GOLDEN_VERSION,
    now: GOLDEN_NOW,
  });
  assert.ok(withAC.text.includes("[projects.auto_compress]"), "fixture 配了 auto_compress,应渲染");

  const orgNoAC = { ...org, company: { ...org.company, defaults: { ...org.company.defaults } } };
  delete (orgNoAC.company.defaults as { auto_compress_max_tokens?: number }).auto_compress_max_tokens;
  const withoutAC = renderConfig({
    org: orgNoAC,
    personas,
    host: GOLDEN_HOST,
    ancVersion: GOLDEN_VERSION,
    now: GOLDEN_NOW,
  });
  assert.ok(!withoutAC.text.includes("[projects.auto_compress]"), "未配置时整段不渲染");
  assert.deepEqual(parseAncToml(withoutAC.text).errors, [], "不渲染该段后仍应可解析");
});

test("golden:快照产物过三重校验(前两层)无 issue", () => {
  const { org, rendered } = renderFixturePipeline();
  assert.deepEqual(validateRoundTrip(rendered, org), []);
  assert.deepEqual(
    validateSemantic(rendered, { org, secrets: fixtureSecrets(), gatewayExtra: gatewayExtraFixture() }),
    [],
  );
});
