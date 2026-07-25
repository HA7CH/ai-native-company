/**
 * toml-roundtrip.test.ts —— mini 解析器的取值语义必须与真 TOML 一致。
 *
 * 本库零运行时依赖,不引真 TOML 解析器。取而代之:下列期望值全部由两个独立的
 * TOML 1.0 实现(@iarna/toml 与 smol-toml)在开发期逐例对拍确认后,固化为字面断言。
 * 改动 literalBlock / literalBlockValue / parseAncToml 的取值行为时,必须先用真解析器
 * 重新对拍再改这里的字面量 —— 不允许「改代码顺手改期望值」。
 *
 * 钉住的核心不变量:TOML 只吞开定界符后紧跟的那个换行,末行结尾的换行属于值。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  basicString,
  literalBlock,
  literalBlockValue,
  parseAncToml,
  sha256,
} from "../src/render/toml";
import { makeOrg, renderFixturePipeline, trivialPersonas } from "./helpers";
import { renderConfig } from "../src/render/toml";
import { validateRoundTrip } from "../src/render/validate";

/** 用 mini 解析器读回单个标量的取值(包在最小合法文档里)。 */
function readBack(assignment: string): unknown {
  const parsed = parseAncToml(`k_unused = "x"\n${assignment}`);
  assert.deepEqual(parsed.errors, [], `不应有解析错误:${JSON.stringify(assignment)}`);
  return parsed.topLevel["k"];
}

test("toml:多行 literal 取值语义与真 TOML 一致(六例,双实现对拍固化)", () => {
  // 期望值来源:@iarna/toml 与 smol-toml 对同一文本的解析结果,二者完全一致。
  const cases: [string, string][] = [
    ["k = '''\n'''", ""], //                     空:开定界符后的换行被吞,无内容
    ["k = '''\n\n'''", "\n"], //                 一个空行 → 一个换行
    ["k = '''\nL1\n'''", "L1\n"], //             单行:末行换行属于值 ← 本次修复的核心
    ["k = '''\nL1\nL2\n'''", "L1\nL2\n"], //     多行
    ["k = '''\nL1\n\n'''", "L1\n\n"], //         尾部空行不被吞
    ["k = '''\n\nL1\n'''", "\nL1\n"], //         首部空行不被吞(只吞紧跟定界符那个)
  ];
  for (const [src, expected] of cases) {
    assert.equal(readBack(src), expected, `取值不符:${JSON.stringify(src)}`);
  }
});

test("toml:literalBlockValue 与 literalBlock 落盘后的读回值恒等", () => {
  const inputs = [
    "",
    "L1",
    "L1\n",
    "L1\n\n\n",
    "## 身份\n\n第一行。\n",
    "\n\n前面有空行\n",
    'has "quotes" and \\ backslash\n第二行\n',
    "emoji🚀与中文\n",
  ];
  for (const s of inputs) {
    const readBackValue = readBack(`k = ${literalBlock(s)}`);
    assert.equal(
      readBackValue,
      literalBlockValue(s),
      `literalBlockValue 未预言读回值:${JSON.stringify(s)}`,
    );
  }
});

test("toml:literalBlock 唯一的内容改写是尾换行归一为恰好一个", () => {
  assert.equal(literalBlockValue("L1"), "L1\n");
  assert.equal(literalBlockValue("L1\n"), "L1\n");
  assert.equal(literalBlockValue("L1\n\n\n"), "L1\n");
  // 非尾部的空行一律保留,不做任何压缩
  assert.equal(literalBlockValue("L1\n\nL2\n"), "L1\n\nL2\n");
  // 含 ''' 一律拒渲,不静默转义
  assert.throws(() => literalBlock("含 ''' 的内容"), /拒绝产出非法 TOML/);
});

test("toml:persona.ts 产物的尾换行归一化是 no-op(锚点即原文)", () => {
  // 这条不变量让「锚点取 literalBlockValue」在真实管线中等价于「锚点取 persona 原文」。
  const { personas, rendered } = renderFixturePipeline();
  for (const [name, p] of Object.entries(personas)) {
    assert.equal(literalBlockValue(p), p, `persona ${name} 应以恰好一个换行结尾`);
  }
  for (const [projectName, anchor] of Object.entries(rendered.personaSha)) {
    const member = projectName.slice(projectName.indexOf("-") + 1);
    assert.equal(anchor, sha256(personas[member] as string), `锚点应等于 persona 原文 hash:${projectName}`);
  }
});

test("toml:basicString 与数组元素转义同构(控制字符不打断 round-trip)", () => {
  // basicString 对控制字符产出 \uXXXX;数组元素解析必须同样认得,否则自家产出读不回。
  const nasty = ["a\u0001b", "tab\there", 'q"uote', "back\\slash", "del\u007f", "nl\nline"];
  assert.deepEqual(readBack(`k = [${nasty.map(basicString).join(", ")}]`), nasty);
  for (const s of nasty) {
    assert.equal(readBack(`k = ${basicString(s)}`), s, `标量 round-trip 失败:${JSON.stringify(s)}`);
  }
});

test("toml:全量 config round-trip —— 每个 persona 逐字节回得来", () => {
  const { org, rendered } = renderFixturePipeline();
  const parsed = parseAncToml(rendered.text);
  assert.deepEqual(parsed.errors, [], "自家产出必须零解析错误");
  assert.deepEqual(validateRoundTrip(rendered, org), [], "三重校验第一层应无 issue");

  // 逐 project:读回的 persona hash == 渲染锚点
  assert.equal(parsed.projects.length, 3);
  for (const p of parsed.projects) {
    const name = p.top["name"] as string;
    const back = p.options["append_system_prompt"];
    assert.equal(typeof back, "string", `${name} 应有 append_system_prompt`);
    assert.equal(sha256(back as string), rendered.personaSha[name], `${name} persona hash 应一致`);
  }
});

test("toml:round-trip 校验能抓住 persona 被篡改(注入/截断)", () => {
  const org = makeOrg();
  const rendered = renderConfig({
    org,
    personas: trivialPersonas(org),
    host: { vaultRoot: "/v", ancHome: "/a" },
    ancVersion: "0.0.0",
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.deepEqual(validateRoundTrip(rendered, org), [], "未篡改时应无 issue");

  // 篡改一个字符 → 必须报 RT-PERSONA(校验不是自证,能真的抓人)
  const tampered = { ...rendered, text: rendered.text.replace("第二行。", "第二行!") };
  const issues = validateRoundTrip(tampered, org);
  assert.equal(issues.length, 1, "篡改应恰好触发一条 issue");
  assert.equal(issues[0]?.rule, "RT-PERSONA");

  // 截断尾换行同样要被抓(本次修复前正是这里漏报/误报的反面)
  const truncated = { ...rendered, personaSha: { ...rendered.personaSha, "unit-alice": sha256("对不上的内容") } };
  const issues2 = validateRoundTrip(truncated, org);
  assert.equal(issues2.length, 1);
  assert.equal(issues2[0]?.rule, "RT-PERSONA");
});

test("toml:非自家产出形态一律报错,不猜(含 [log]] 这类畸形表头)", () => {
  const bad = [
    "[log]]", //            畸形表头:多一个右括号
    "[[log]]", //           已知表不接受数组表形态
    "[unknown_table]", //   未知表
    "k = '''\nL1", //       multi-line literal 未闭合
    'k = "unclosed', //     字符串未闭合
    'k = ["a", 1]', //      数组元素非 basic string
    "k = maybe", //         裸值
  ];
  for (const src of bad) {
    const parsed = parseAncToml(src);
    assert.ok(parsed.errors.length > 0, `应报错但没报:${JSON.stringify(src)}`);
  }
});
