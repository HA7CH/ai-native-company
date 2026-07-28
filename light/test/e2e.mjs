#!/usr/bin/env node
/**
 * anc-vault 端到端回归测试(零依赖)。
 *
 * 覆盖的是「多人在同一份 vault 上写一份报告」这条真实链路 —— 每个用例都对应一个
 * 在真实的大体量 vault 上实测暴露过的失败模式。
 *
 * 用法:
 *   node light/test/e2e.mjs [endpoint] [token]
 *   默认 http://127.0.0.1:8799 / test-token-local-only(wrangler dev --port 8799)
 *
 * 前置:vault 里要有一些内容(空库也能跑,但覆盖度低)。
 */

const ENDPOINT = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const TOKEN = process.argv[3] ?? "test-token-local-only";
const NS = `_e2e/${Date.now().toString(36)}`;

let pass = 0;
let fail = 0;
const failures = [];

// 护栏:vault 刻意没有删除接口(员工删不掉,只有管理员能从 R2 侧删),所以测试写进去的
// 数据清不掉。对着生产库跑会永久留下 _e2e/ 垃圾 —— 必须显式 --i-know 才允许。
{
  const probe = await fetch(`${ENDPOINT}/manifest`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (probe.ok) {
    const m = await probe.json();
    const real = m.entries.filter((e) => !e.path.startsWith("_e2e/"));
    const local = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(ENDPOINT);
    if (real.length > 0 && !local && !process.argv.includes("--i-know")) {
      console.error(
        `\x1b[31m拒绝执行\x1b[0m:${ENDPOINT} 里已有 ${real.length} 个真实文件,而本测试会写入无法删除的数据。\n` +
          `请对着专用测试实例跑;确实要继续加 --i-know。`,
      );
      process.exit(2);
    }
  }
}

function ok(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

async function http(pathname, opts = {}) {
  return fetch(`${ENDPOINT}${pathname}`, {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) },
  });
}

async function tool(name, args) {
  const res = await http("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  if (j.error) return { text: j.error.message, isError: true };
  return {
    text: (j.result?.content ?? []).map((c) => c.text).join("\n"),
    isError: !!j.result?.isError,
  };
}

/** 从 vault_read 的第二个 content block 里抠出 etag */
function etagOf(text) {
  return text.match(/\[vault-meta\][^\n]*etag=(\S+)/)?.[1] ?? null;
}

// ============================================================
section("1. 分层:manifest 只含 index 层,原件不进同步清单");
// ============================================================
{
  const res = await http("/manifest");
  ok("GET /manifest 返回 200", res.status === 200, `实际 ${res.status}`);
  const m = await res.json();
  const hasOriginals = m.entries.some((e) => e.path.split("/").includes("_originals"));
  ok("清单里没有任何 _originals/ 下的原件", !hasOriginals);
  const allText = m.entries.every((e) => /\.(md|markdown|json|jsonl|txt|ya?ml|csv|toml|xml|html)$/i.test(e.path) || !/\.[a-z0-9]+$/i.test(e.path));
  ok("清单里全是文本文件", allText);
  ok("每条都带 etag(增量 diff 的依据)", m.entries.every((e) => e.etag && e.size >= 0));

  const etag = res.headers.get("etag");
  const again = await http("/manifest", { headers: { "If-None-Match": etag } });
  ok("清单没变时返回 304(pull 是一次空往返)", again.status === 304, `实际 ${again.status}`);
}

// ============================================================
section("2. 搜索完整性:命中「面」必须是完整的");
// ============================================================
{
  // 造一个高频词,分布在多个文件里,且让其中一个文件的命中数远超其余
  const files = [];
  for (let i = 0; i < 12; i++) {
    const lines =
      i === 0
        ? Array.from({ length: 150 }, (_, n) => `第 ${n} 行 ZQMARKER 密集命中`) // 单文件 150 行命中
        : [`ZQMARKER 只出现一次`];
    const p = `${NS}/search/f${String(i).padStart(2, "0")}.md`;
    await tool("vault_write", { path: p, content: lines.join("\n"), author: "e2e", reason: "搜索完整性用例" });
    files.push(p);
  }

  const r = await tool("vault_search", { query: "ZQMARKER", path: `${NS}/search` });
  const reported = new Set([...r.text.matchAll(/^(\S+\.md):\d+:/gm)].map((m) => m[1]));
  ok(
    "一个 150 行命中的大文件不会吃掉其余文件的展示位",
    reported.size === 12,
    `只报告了 ${reported.size}/12 个文件`,
  );
  ok("头部声明的命中文件数正确", /命中 12 个文件/.test(r.text), r.text.split("\n")[0]);
  ok("对被省略的行有显式说明", /另有 \d+ 行命中未展示/.test(r.text));
  ok("结果里带「这是样本、不能证明没有」的告诫", /不能据此断言/.test(r.text));
}

// ============================================================
section("3. 大文件不再让整个范围的搜索静默归零");
// ============================================================
{
  // v1: 遇到放不下的文件 `break scan` 终止整个扫描 —— 此后该范围任何搜索永远返回 0 命中
  const big = "x".repeat(1024 * 1024 + 512) + "\nNEEDLE_IN_BIG\n";
  const putBig = await http(`/raw/${NS}/big/zzz-huge.md`, {
    method: "PUT",
    body: big,
    headers: { "x-anc-author": encodeURIComponent("测试") },
  });
  ok("超大文本文件可以经 /raw 流式写入", putBig.status === 201, `实际 ${putBig.status}`);
  await tool("vault_write", { path: `${NS}/big/aaa-small.md`, content: "NEEDLE_SMALL 在小文件里", author: "e2e" });

  const r = await tool("vault_search", { query: "NEEDLE", path: `${NS}/big` });
  ok("同目录下的小文件仍然搜得到(没有被大文件带崩)", /aaa-small\.md/.test(r.text), r.text.split("\n")[0]);
  ok("被跳过的大文件被点名告知,而不是静默吞掉", /超过单文件上限被跳过/.test(r.text) && /zzz-huge/.test(r.text));
}

// ============================================================
section("4. 写报告:两个人同时改同一份,后写的不能静默抹掉先写的");
// ============================================================
{
  const REPORT = `${NS}/交付/尽调报告初稿.md`;
  const v0 = ["# 财务尽职调查报告(初稿)", "", "## 一、基本情况", "待补", "", "## 二、主要发现", "待补"].join("\n");

  const created = await tool("vault_write", { path: REPORT, content: v0, author: "甲", reason: "起初稿" });
  ok("甲创建报告初稿", !created.isError, created.text);

  // 甲和乙在同一时刻各读一次 —— 拿到同一个 etag
  const readA = await tool("vault_read", { path: REPORT });
  const readB = await tool("vault_read", { path: REPORT });
  const etagA = etagOf(readA.text);
  const etagB = etagOf(readB.text);
  ok("vault_read 返回 etag(写回时的凭据)", !!etagA, readA.text.slice(-120));
  ok("甲乙读到同一版本", etagA === etagB);

  // 乙先写:补第二节
  const vB = v0.replace("## 二、主要发现\n待补", "## 二、主要发现\n乙补充:关联方交易 3 笔,金额待核");
  const wroteB = await tool("vault_write", { path: REPORT, content: vB, base_etag: etagB, author: "乙", reason: "补主要发现" });
  ok("乙带着自己读到的 etag 写入,成功", !wroteB.isError, wroteB.text);

  // 甲后写:他手里还是旧 etag —— 这就是「上午读、下午写」
  const vA = v0.replace("## 一、基本情况\n待补", "## 一、基本情况\n甲补充:目标公司成立于 2013 年");
  const wroteA = await tool("vault_write", { path: REPORT, content: vA, base_etag: etagA, author: "甲", reason: "补基本情况" });
  ok("★ 甲拿过期版本写入被拒绝(v1 在这里会静默抹掉乙的改动)", wroteA.isError, wroteA.text);
  ok("拒绝理由说清了是版本过期、且指路怎么办", /版本已过期/.test(wroteA.text) && /重新 vault_read/.test(wroteA.text));

  // 乙的内容确实还在
  const after = await tool("vault_read", { path: REPORT });
  ok("乙的改动没有丢", /关联方交易 3 笔/.test(after.text));

  // 甲重新读、合并、再写
  const etagNow = etagOf(after.text);
  const merged = vB.replace("## 一、基本情况\n待补", "## 一、基本情况\n甲补充:目标公司成立于 2013 年");
  const wroteMerged = await tool("vault_write", { path: REPORT, content: merged, base_etag: etagNow, author: "甲", reason: "合并后重写" });
  ok("甲重新读取合并后写入成功", !wroteMerged.isError, wroteMerged.text);

  const final = await tool("vault_read", { path: REPORT });
  ok("最终版同时包含甲和乙的改动", /关联方交易 3 笔/.test(final.text) && /成立于 2013 年/.test(final.text));

  // 不带 base_etag 覆盖已有文件 → 拒绝
  const naked = await tool("vault_write", { path: REPORT, content: "整段覆盖", author: "丙" });
  ok("★ 不带 base_etag 覆盖已有文件被拒绝(强制 read-before-write)", naked.isError, naked.text);

  // 历史可回溯
  const hist = await tool("vault_history", { path: REPORT });
  ok("每一版都留了档,能看到谁改的、为什么", /替换者=乙/.test(hist.text) || /替换者=甲/.test(hist.text), hist.text.split("\n")[0]);
}

// ============================================================
section("5. 原件:不经模型搬运,按需单取");
// ============================================================
{
  const ORIG = `${NS}/_originals/A1审签表/扫描件.bin`;
  const payload = Buffer.from("%PDF-1.4\n" + "S".repeat(200_000));
  const put = await http(`/raw/${ORIG}`, {
    method: "PUT",
    body: payload,
    headers: { "x-anc-author": encodeURIComponent("库管"), "x-anc-reason": encodeURIComponent("原件入库") },
  });
  ok("原件经 /raw 流式上传(不经 JSON、不经模型)", put.status === 201, `实际 ${put.status}`);

  const dup = await http(`/raw/${ORIG}`, { method: "PUT", body: payload });
  ok("★ 重复上传被拒(铁律:原件永不改动、永不覆盖)", dup.status === 412, `实际 ${dup.status}`);

  const info = await tool("vault_original", { path: ORIG });
  ok("vault_original 给出 curl 直链而不是文件内容", /curl/.test(info.text) && /\/raw\//.test(info.text));
  ok("返回体里没有把原件字节塞进来", info.text.length < 2000, `返回了 ${info.text.length} 字符`);
  ok("提示了该原件有没有 OCR 文本", /OCR/.test(info.text));

  const got = await http(`/raw/${ORIG}`);
  const buf = Buffer.from(await got.arrayBuffer());
  ok("流式取回的字节与上传完全一致", buf.length === payload.length && buf.equals(payload));

  const ranged = await http(`/raw/${ORIG}`, { headers: { Range: "bytes=0-99" } });
  ok("支持 Range(GB 级文件可按页取,不必整份下载)", ranged.status === 206, `实际 ${ranged.status}`);
  ok("Range 响应带正确的 content-range", /bytes 0-99\/\d+/.test(ranged.headers.get("content-range") ?? ""));

  // 读一个二进制路径时不应该吐字节
  const readBin = await tool("vault_read", { path: ORIG });
  ok("vault_read 碰到原件时改为指路,不吐字节", /vault_original/.test(readBin.text));
}

// ============================================================
section("6. 中文:作者名与路径全链路往返");
// ============================================================
{
  const P = `${NS}/中文目录/带空格 和(括号).md`;
  const w = await tool("vault_write", { path: P, content: "内容", author: "张三", reason: "中文原因测试" });
  ok("中文路径 + 空格 + 括号可写入", !w.isError, w.text);
  const r = await tool("vault_read", { path: P });
  ok("中文路径可读回", /内容/.test(r.text));

  const ORIG2 = `${NS}/_originals/中文原件/合同扫描件.bin`;
  const put = await http(`/raw/${ORIG2.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    body: Buffer.from("data"),
    headers: { "x-anc-author": encodeURIComponent("李四"), "x-anc-reason": encodeURIComponent("中文原因") },
  });
  ok("★ 中文作者名经 header 上传不再抛异常(必须 percent-encode)", put.status === 201, `实际 ${put.status}`);
}

// ============================================================
section("7. vault_list 前缀模式");
// ============================================================
{
  await tool("vault_write", { path: `${NS}/list/2025-甲项目/a.md`, content: "x", author: "e2e" });
  await tool("vault_write", { path: `${NS}/list/2025-乙项目/a.md`, content: "x", author: "e2e" });
  await tool("vault_write", { path: `${NS}/list/2024-丙项目/a.md`, content: "x", author: "e2e" });

  const dir = await tool("vault_list", { path: `${NS}/list/` });
  ok("目录模式列出三个子目录", (dir.text.match(/<目录>/g) ?? []).length === 3, dir.text);

  const pre = await tool("vault_list", { path: `${NS}/list/2025-` });
  ok("★ 前缀模式可用(v1 这里必定返回「目录为空」)", /甲项目/.test(pre.text) && /乙项目/.test(pre.text), pre.text);
  ok("前缀模式不误纳 2024 的项目", !/丙项目/.test(pre.text));
}

// ============================================================
section("8. 写入护栏");
// ============================================================
{
  const big = await tool("vault_write", { path: `${NS}/guard/toobig.md`, content: "x".repeat(1024 * 1024 + 10), author: "e2e" });
  ok("超过单文本上限被拒(大文本会拖垮所在范围的搜索)", big.isError && /超过单文本上限/.test(big.text));

  const bin = await tool("vault_write", { path: `${NS}/guard/x.pdf`, content: "假装是 pdf", author: "e2e" });
  ok("试图用 MCP 写二进制路径被拒(指路去 /raw)", bin.isError && /\/raw/.test(bin.text));

  const hist = await tool("vault_write", { path: `_history/${NS}/x.md`, content: "篡改历史", author: "e2e" });
  ok("_history/ 拒写", hist.isError);

  const trav = await tool("vault_read", { path: `${NS}/../../etc/passwd` });
  ok("路径穿越被拒", /错误/.test(trav.text) || /不允许/.test(trav.text), trav.text.slice(0, 120));

  const noAuth = await fetch(`${ENDPOINT}/manifest`);
  ok("无 token 访问 /manifest 被拒", noAuth.status === 401, `实际 ${noAuth.status}`);
  const badAuth = await fetch(`${ENDPOINT}/raw/whatever`, { headers: { Authorization: "Bearer wrong" } });
  ok("错 token 访问 /raw 被拒", badAuth.status === 401, `实际 ${badAuth.status}`);
}

// ============================================================
console.log(`\n${"─".repeat(60)}`);
console.log(`\x1b[1m${pass} 通过, ${fail} 失败\x1b[0m`);
if (fail) {
  console.log("\n失败项:");
  for (const f of failures) console.log(`  ✗ ${f}`);
}
console.log(`\n清理:测试数据都在 ${NS}/ 下(以及它的 _history)。`);
process.exit(fail ? 1 : 0);
