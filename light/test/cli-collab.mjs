#!/usr/bin/env node
/**
 * anc CLI 协作回归测试:「两个人同时写一份报告」的完整链路。
 *
 * 为什么单独一份:服务端的 base_etag 只挡住了**写入**侧的 lost update,客户端还有两个
 * 同源的洞,都是在真实数据上实测撞出来的 ——
 *   1. push 后不更新本地清单 → 下次 pull 把这个文件当「远端新增」直接下载,静默盖掉本地版本
 *   2. pull 遇冲突后保留旧 etag → 合并完也永远 push 不进去(死锁,用户无法脱困)
 * 这两个都不经过 HTTP 层的用例,必须在 CLI 这一层测。
 *
 * 用法:node light/test/cli-collab.mjs [endpoint] [token]
 * 会用一个临时 HOME,不碰你真实的 ~/.anc。
 */

import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const ENDPOINT = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/$/, "");
const TOKEN = process.argv[3] ?? "test-token-local-only";
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cli", "anc.mjs");
const NS = `_e2ecli/${Date.now().toString(36)}`;
const REPORT = `${NS}/交付/报告初稿.md`;

let pass = 0,
  fail = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ""}`);
  }
};

// 临时 HOME,避免污染真实配置
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "anc-cli-test-"));
const env = { ...process.env, HOME };
const anc = async (...args) => {
  try {
    const { stdout, stderr } = await exec("node", [CLI, ...args], { env });
    return { out: stdout + stderr, code: 0 };
  } catch (e) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.code ?? 1 };
  }
};
const tool = async (name, args) => {
  const res = await fetch(`${ENDPOINT}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const j = await res.json();
  return (j.result?.content ?? []).map((c) => c.text).join("\n");
};

console.log(`\x1b[1m写报告协作链路（临时 HOME: ${HOME}）\x1b[0m`);

await anc("init", ENDPOINT, TOKEN, "--name", "t");
const ROOT = (await anc("where")).out.trim();
await anc("pull");

// —— 甲起草并推上去
const REPORT_ABS = path.join(ROOT, REPORT);
await fs.mkdir(path.dirname(REPORT_ABS), { recursive: true });
await fs.writeFile(REPORT_ABS, "# 报告\n\n## 一、情况\n甲起草\n\n## 二、发现\nTBC\n");
const pushed = await anc("push", REPORT_ABS, "--author", "甲", "--reason", "起草");
ok("甲起草并 push 成功", /已写入/.test(pushed.out), pushed.out);

// —— 乙在另一台机器上改了同一份
const etag = (await tool("vault_read", { path: REPORT })).match(/etag=(\S+)/)?.[1];
await tool("vault_write", {
  path: REPORT,
  content: "# 报告\n\n## 一、情况\n乙改写\n\n## 二、发现\n乙补充:需核实\n",
  base_etag: etag,
  author: "乙",
  reason: "补发现",
});

// —— 甲本地也改了,然后 pull
await fs.appendFile(REPORT_ABS, "\n## 三、风险\n甲补充\n");
const pull1 = await anc("pull");
ok("★ pull 检测到双方都改并报冲突", /冲突/.test(pull1.out), pull1.out);

const afterPull = await fs.readFile(REPORT_ABS, "utf8");
ok("★ 甲的本地改动没有被 pull 静默覆盖", /甲补充/.test(afterPull), afterPull);
const remoteCopy = await fs.readFile(REPORT_ABS + ".remote", "utf8").catch(() => "");
ok("对方的版本被完整存到 .remote 供比对", /乙补充/.test(remoteCopy));
ok("冲突提示里给出了解决办法", /--resolved/.test(pull1.out));

// —— 不合并硬推:必须被拒
const forced = await anc("push", REPORT_ABS, "--author", "甲", "--reason", "硬推");
ok("★ 不合并直接 push 被拒(版本过期)", forced.code !== 0 && /版本已过期/.test(forced.out), forced.out);

// —— 合并后用 --resolved 提交
await fs.writeFile(REPORT_ABS, "# 报告\n\n## 一、情况\n乙改写\n\n## 二、发现\n乙补充:需核实\n\n## 三、风险\n甲补充\n");
const resolved = await anc("push", REPORT_ABS, "--resolved", "--author", "甲", "--reason", "合并后提交");
ok("★ 合并后 --resolved 能提交成功(不再死锁)", resolved.code === 0 && /已写入/.test(resolved.out), resolved.out);

const finalText = await tool("vault_read", { path: REPORT });
ok("最终版同时保留了甲和乙的改动", /甲补充/.test(finalText) && /乙补充/.test(finalText));
ok(".remote 副本已清理", !(await fs.stat(REPORT_ABS + ".remote").catch(() => null)));

const pull2 = await anc("pull");
ok("解决后再 pull 干净无冲突", /无改动|已是最新/.test(pull2.out), pull2.out);

// —— 每一版都留了档
const hist = await tool("vault_history", { path: REPORT });
ok("三次写入都在历史里可回溯", (hist.match(/替换者=/g) ?? []).length >= 2, hist.split("\n")[0]);

// —— push 后不 pull 也不会丢:清单已就地更新
const P2 = `${NS}/交付/另一份.md`;
const P2_ABS = path.join(ROOT, P2);
await fs.writeFile(P2_ABS, "第一版\n");
await anc("push", P2_ABS, "--author", "甲");
await fs.writeFile(P2_ABS, "第一版\n本地又加的一行\n");
await anc("pull");
ok(
  "★ push 之后紧接着 pull,本地后续改动不会被当「远端新增」冲掉",
  /本地又加的一行/.test(await fs.readFile(P2_ABS, "utf8")),
);

// —— 单文件下载失败不能污染 manifest,否则下次 pull 会误判为已同步而永不重试
const RETRY = `${NS}/交付/需重试.md`;
await tool("vault_write", { path: RETRY, content: "这份必须下载\n", author: "乙" });
const retryUrl = `/raw/${RETRY.split("/").map(encodeURIComponent).join("/")}`;
const proxy = createServer(async (req, res) => {
  if (req.url === retryUrl) {
    res.writeHead(503).end("injected download failure\n");
    return;
  }
  const upstream = await fetch(`${ENDPOINT}${req.url}`, {
    method: req.method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
  res.end(Buffer.from(await upstream.arrayBuffer()));
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyAddress = proxy.address();
const proxyEndpoint = `http://127.0.0.1:${proxyAddress.port}`;
const configPath = path.join(HOME, ".anc", "config.json");
const config = JSON.parse(await fs.readFile(configPath, "utf8"));
await fs.writeFile(configPath, JSON.stringify({ ...config, endpoint: proxyEndpoint }, null, 2) + "\n");

const failedPull = await anc("pull", "--force");
ok("★ 单文件下载失败时 pull 返回非零", failedPull.code !== 0, failedPull.out);
ok("下载失败的文件没有伪装成本地已存在", !(await fs.stat(path.join(ROOT, RETRY)).catch(() => null)));

await fs.writeFile(configPath, JSON.stringify({ ...config, endpoint: ENDPOINT }, null, 2) + "\n");
await new Promise((resolve, reject) => proxy.close((err) => (err ? reject(err) : resolve())));
const retriedPull = await anc("pull", "--force");
ok("★ 下次 pull 会重试并补齐上次失败的文件", /\u8fd9\u4efd\u5fc5\u987b\u4e0b\u8f7d/.test(await fs.readFile(path.join(ROOT, RETRY), "utf8")), retriedPull.out);

// —— 远端删除时,本地已编辑的版本必须保留
const REMOVED = `${NS}/交付/远端已删.md`;
const removedAbs = path.join(ROOT, REMOVED);
const baseline = Buffer.from("旧版\n");
await fs.writeFile(removedAbs, baseline);
const manifestFile = path.join(ROOT, ".anc", "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
manifest.entries.push({
  path: REMOVED,
  etag: "deleted-remotely",
  size: baseline.length,
  localHash: crypto.createHash("sha256").update(baseline).digest("hex"),
});
manifest.etag = null;
await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
await fs.writeFile(removedAbs, "我的本地未回传修改\n");

const deletionPull = await anc("pull", "--force");
ok("★ 远端删除不会顺带删掉本地未回传修改", /本地未回传修改/.test(await fs.readFile(removedAbs, "utf8")), deletionPull.out);
ok("远端删除冲突被明确报告", /已从远端删除/.test(deletionPull.out), deletionPull.out);

await fs.rm(HOME, { recursive: true, force: true });
console.log(`\n${"─".repeat(50)}\n\x1b[1m${pass} 通过, ${fail} 失败\x1b[0m`);
if (fail) console.log("失败项:\n  " + failures.join("\n  "));
process.exit(fail ? 1 : 0);
