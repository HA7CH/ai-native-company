import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseFrontmatter } from "../src/org/frontmatter";

function fm(lines: string[]): string {
  return ["---", ...lines, "---", "", "正文第一行"].join("\n");
}

test("frontmatter:标量/布尔/整数/双引号/注释/空行", () => {
  const r = parseFrontmatter(
    fm([
      "name: Demo Trading Co        # 显示名",
      "id: demo",
      "",
      "count: 15",
      "pi: 3.5",
      "flag: true",
      "off: false",
      'quoted: "a: b # c"',
      'escaped: "he said \\"hi\\" \\\\ ok"',
      "empty_str: \"\"",
    ]),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.data["name"], "Demo Trading Co");
  assert.equal(r.data["id"], "demo");
  assert.equal(r.data["count"], 15);
  assert.equal(r.data["pi"], 3.5);
  assert.equal(r.data["flag"], true);
  assert.equal(r.data["off"], false);
  assert.equal(r.data["quoted"], "a: b # c");
  assert.equal(r.data["escaped"], 'he said "hi" \\ ok');
  assert.equal(r.data["empty_str"], "");
  assert.equal(r.keyLines["name"], 2);
  assert.equal(r.keyLines["count"], 5);
});

test("frontmatter:数组(空/裸元素/引号元素)", () => {
  const r = parseFrontmatter(fm(["a: []", "b: [x, y-z]", 'c: [x, "y, z"]']));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.data["a"], []);
  assert.deepEqual(r.data["b"], ["x", "y-z"]);
  assert.deepEqual(r.data["c"], ["x", "y, z"]);
});

test("frontmatter:一层嵌套映射(标量+数组+注释)", () => {
  const r = parseFrontmatter(
    fm(["defaults:", "  model: claude-sonnet-5", "  max: 120000   # tokens", "  tools: [Read, Grep]", "next: 1"]),
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.data["defaults"], { model: "claude-sonnet-5", max: 120000, tools: ["Read", "Grep"] });
  assert.equal(r.data["next"], 1);
  assert.equal(r.keyLines["defaults.model"], 3);
});

test("frontmatter:body 与 bodyStartLine", () => {
  const r = parseFrontmatter("---\na: 1\n---\n\n正文第一行\n第二行");
  assert.deepEqual(r.errors, []);
  assert.equal(r.body, "\n正文第一行\n第二行");
  assert.equal(r.bodyStartLine, 4);
});

test("frontmatter:缺开头 --- 报错", () => {
  const r = parseFrontmatter("name: x\n---\n");
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]?.line, 1);
  assert.match(r.errors[0]?.message ?? "", /---/);
});

test("frontmatter:未闭合报错", () => {
  const r = parseFrontmatter("---\nname: x\n");
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]?.message ?? "", /未闭合/);
});

test("frontmatter:越界形态逐一报错且带行号", () => {
  const cases: { line: string; re: RegExp }[] = [
    { line: "- item", re: /块列表/ },
    { line: "key: |", re: /多行标量/ },
    { line: "key: >", re: /多行标量/ },
    { line: "key: &anchor", re: /锚点/ },
    { line: "key: *alias", re: /锚点/ },
    { line: "key: 'single'", re: /单引号/ },
    { line: "key: {a = 1}", re: /内联映射/ },
    { line: "key: null", re: /null 不在子集内/ },
    { line: "key: ~", re: /null 不在子集内/ },
    { line: "\tkey: 1", re: /tab/ },
    { line: "key: [a, b", re: /闭合/ },
    { line: "key: [a,, b]", re: /空元素/ },
    { line: 'key: "未闭合', re: /未闭合/ },
    { line: 'key: "x" y', re: /多余内容/ },
    { line: 'key: "bad \\q escape"', re: /转义/ },
  ];
  for (const c of cases) {
    const r = parseFrontmatter(fm([c.line]));
    assert.ok(r.errors.length >= 1, `应报错:${c.line}`);
    assert.match(r.errors[0]?.message ?? "", c.re, `报错信息不符:${c.line} → ${r.errors[0]?.message}`);
    assert.equal(r.errors[0]?.line, 2, `行号应为 2:${c.line}`);
  }
});

test("frontmatter:重复键报错", () => {
  const r = parseFrontmatter(fm(["a: 1", "a: 2"]));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]?.message ?? "", /重复的键/);
  assert.equal(r.errors[0]?.line, 3);
});

test("frontmatter:嵌套内重复键报错", () => {
  const r = parseFrontmatter(fm(["m:", "  a: 1", "  a: 2"]));
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]?.message ?? "", /重复的键 `m.a`/);
});

test("frontmatter:二层嵌套越界报错并指出行号", () => {
  const r = parseFrontmatter(fm(["m:", "  sub:", "    deep: 1"]));
  assert.ok(r.errors.length >= 1);
  assert.match(r.errors[0]?.message ?? "", /嵌套映射仅支持一层/);
  assert.equal(r.errors[0]?.line, 3);
});

test("frontmatter:嵌套缩进不一致报错", () => {
  const r = parseFrontmatter(fm(["m:", "  a: 1", "    b: 2"]));
  assert.ok(r.errors.length >= 1);
  assert.match(r.errors[0]?.message ?? "", /缩进须一致/);
});

test("frontmatter:顶层空值(裸 key:)报错", () => {
  const r = parseFrontmatter(fm(["m:", "next: 1"]));
  assert.ok(r.errors.length >= 1);
  assert.match(r.errors[0]?.message ?? "", /空值不在子集内/);
});

test("frontmatter:游离缩进行报错", () => {
  const r = parseFrontmatter(fm(["a: 1", "  b: 2"]));
  assert.ok(r.errors.length >= 1);
  assert.match(r.errors[0]?.message ?? "", /缩进越界/);
});
