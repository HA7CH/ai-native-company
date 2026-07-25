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
import { disabledCommands, FINGERPRINT_RE, gatewayLanguage, parseAncToml, renderConfig } from "../src/render/toml";
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
      const allow = (platform.options["allow_from"] as string).split(",");
      assert.deepEqual(allow, [...new Set(allow)], "allow_from 必须去重");
      for (const admin of adminIds) assert.ok(allow.includes(admin as string), "allow_from 必须含全部 admin");
      assert.ok(!allow.includes("*"), "allow_from 不得含通配符");
    }
  }
});

test("golden:allow_from/allow_chat 必须是逗号串 —— 数组形态在上游等于全员放行", () => {
  // 这条钉的是一个真实的 fail-open:上游 14 个 platform 一律 `opts["allow_from"].(string)`
  // (v1.3.4 platform/feishu/feishu.go:222),TOML 数组解出 []any → 断言失败 → 空串,
  // 而 core.AllowList 对空串 `return true`,任何人都能对话。形态错不会报错、只在 stdout
  // 留一条 warn,所以必须由我们自己钉死。
  const { rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  for (const p of parsed.projects) {
    const name = p.top["name"];
    for (const platform of p.platforms) {
      assert.equal(typeof platform.options["allow_from"], "string", `${name} 的 allow_from 必须是字符串`);
      const chat = platform.options["allow_chat"];
      if (chat !== undefined) assert.equal(typeof chat, "string", `${name} 的 allow_chat 必须是字符串`);
    }
  }
  assert.ok(!/allow_from\s*=\s*\[/.test(rendered.text), "渲染文本不得出现 allow_from = [");
  assert.ok(!/allow_chat\s*=\s*\[/.test(rendered.text), "渲染文本不得出现 allow_chat = [");
});

test("golden:language 映射为上游字面量 —— 原样透传会招致上游回写我们的 config", () => {
  // 上游 switch(cmd/cc-connect/main.go:331-345)只认 zh/zh-TW/ja/es/en 等字面量,其余一律
  // 落 LangAuto;而**仅当** LangAuto 时才注册语言回写钩子(main.go:801-805),第一条中文消息
  // 就会 SaveLanguage 就地 patch config.toml(顺带经 formatTOML 删空段)—— 指纹立即失配,
  // deploy 会把上游的自动回写误判成人为手改事故。org 侧写 BCP-47,渲染层负责映射。
  const { org, rendered } = renderFixturePipeline();
  assert.equal(org.company.language, "zh-CN", "fixture 以 BCP-47 书写(映射的输入侧)");
  assert.match(rendered.text, /^language = "zh"$/m, "渲染产物必须是上游认得的 zh");

  assert.equal(gatewayLanguage("zh-CN"), "zh");
  assert.equal(gatewayLanguage("zh-Hans"), "zh");
  assert.equal(gatewayLanguage("zh-TW"), "zh-TW");
  assert.equal(gatewayLanguage("en-US"), "en");
  // 不可映射的取值必须拒渲,绝不原样透传
  assert.throws(() => gatewayLanguage("de-DE"), /无法映射/);
  assert.throws(() => gatewayLanguage("zh-CN-x-private"), /无法映射/);
});

test("golden:auto_compress 显式 enabled —— 只写 max_tokens 是语义失效的死配置", () => {
  // 上游 `Enabled *bool` 默认 nil(config.go:442 注释 "default false"),
  // main.go:619 `if Enabled != nil && *Enabled` 直接短路。
  const { rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  for (const p of parsed.projects) {
    const ac = p.autoCompress;
    assert.ok(ac, `${p.top["name"]} 应有 auto_compress 段`);
    assert.equal(ac["enabled"], true, `${p.top["name"]} 的 auto_compress 必须显式 enabled = true`);
    assert.equal(typeof ac["max_tokens"], "number");
  }
});

test("golden:disabled_commands 封住 /mode 运行时提权与 config 回写", () => {
  // /mode 不在上游 privilegedCommands 表(core/engine.go:1004),cmdMode 也不校验管理员 ——
  // 任何 allow_from 内的用户发 `/mode bypassPermissions` 即可提权角色 bot。渲染 config 挡不住,
  // 只能靠 project 级 disabled_commands。/provider 与 /model 则会回写 config.toml 制造指纹漂移。
  const { rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  for (const p of parsed.projects) {
    const name = p.top["name"] as string;
    const dc = p.top["disabled_commands"];
    assert.ok(Array.isArray(dc), `${name} 必须渲染 disabled_commands`);
    const list = dc as string[];
    assert.ok(list.includes("provider") && list.includes("model"), `${name} 必须禁 provider/model(config 回写)`);
    if (name === "demo-devbot") {
      assert.ok(!list.includes("mode"), "devbot 本就是最高权限档,不禁 mode");
    } else {
      assert.ok(list.includes("mode"), `${name} 是角色 bot,必须禁 mode(SPEC §7 红线的运行时闭环)`);
    }
  }
  assert.deepEqual(disabledCommands(false), ["mode", "provider", "model"]);
  assert.deepEqual(disabledCommands(true), ["provider", "model"]);
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
