#!/usr/bin/env node
/**
 * anc — 公司共享 vault 的本地镜像工具(零依赖,Node 18+)
 *
 * 适用形态 B(原件层 GB 级,git 兜不住)。形态判断见 docs/VAULT-FORMS.md ——
 * 原件少的公司直接用 git 仓库就够了,不需要本工具。
 *
 * 解决的问题:vault 在云上,本地的 Claude Code / Codex 读不到 —— 每问一个问题都要走
 * 一次网络,而服务端搜索在大体量下会截断、会静默返回不完整结果。
 *
 * 做法:把 vault 分层,只把**该同步的那层**镜像到本地。
 *
 *   index 层(结构化 md + OCR 文本)   MB 级   → 全量镜像,agent 用 rg 全速搜,无截断
 *   originals 层(PDF/扫描件/影像)    GB 级   → 永不全量同步,`anc open` 按需单取
 *
 * 典型的 vault 里 markdown 只占总体积的千分之几,所以 index 层的增量同步是毫秒级的 ——
 * 「云上唯一一份 + 全员即时可见 + 本地全速 grep」三者可以同时成立。
 *
 * 命令:
 *   anc init <endpoint> <token> [--name <公司名>]   写配置
 *   anc pull                                        增量同步 index 层到本地
 *   anc status                                      看本地与远端的差异(不改任何东西)
 *   anc open <vault路径> [--open]                   按需取一份原件到本地缓存
 *   anc push <本地路径> [--as <vault路径>]           回写:文本走 MCP(留历史+CAS),原件走 /raw
 *   anc where                                       打印本地镜像根目录
 */

import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const HOME = os.homedir();
const ANC_DIR = path.join(HOME, ".anc");
const CONFIG_PATH = path.join(ANC_DIR, "config.json");
const DOWNLOAD_CONCURRENCY = 8;

// ---------- 小工具 ----------

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

function die(msg) {
  console.error(red(`✗ ${msg}`));
  process.exit(1);
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function loadConfig() {
  try {
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
    if (!cfg.endpoint || !cfg.token) throw new Error("配置不完整");
    return cfg;
  } catch {
    die(`还没配置。先跑:\n    anc init https://<worker域名> <token> --name <公司名>`);
  }
}

function mirrorRoot(cfg) {
  return path.join(ANC_DIR, "vault", cfg.name);
}
function stateDir(cfg) {
  return path.join(mirrorRoot(cfg), ".anc");
}
function manifestPath(cfg) {
  return path.join(stateDir(cfg), "manifest.json");
}
function originalsCache(cfg) {
  return path.join(stateDir(cfg), "originals");
}

async function loadLocalManifest(cfg) {
  try {
    return JSON.parse(await fs.readFile(manifestPath(cfg), "utf8"));
  } catch {
    return { etag: null, entries: [] };
  }
}

async function api(cfg, pathname, opts = {}) {
  const url = `${cfg.endpoint.replace(/\/$/, "")}${pathname}`;
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(opts.headers ?? {}) },
  });
  return res;
}

/** 调 MCP 控制面(CLI 是程序不是模型,走 JSON-RPC 没有 token 成本) */
async function mcp(cfg, name, args) {
  const res = await api(cfg, "/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) die(`MCP 调用失败 HTTP ${res.status}:${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  if (j.error) die(`MCP 错误:${j.error.message}`);
  const text = (j.result?.content ?? []).map((c) => c.text).join("\n");
  return { text, isError: !!j.result?.isError };
}

async function pool(items, limit, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- init ----------

async function cmdInit(argv) {
  const [endpoint, token] = argv;
  if (!endpoint || !token)
    die("用法:anc init https://<worker域名> <token> [--name <公司名>]");
  const nameIdx = argv.indexOf("--name");
  const name = nameIdx >= 0 ? argv[nameIdx + 1] : "default";

  const probe = await fetch(`${endpoint.replace(/\/$/, "")}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (probe.status === 401) die("token 不对(401)。找管理员重新要一个。");
  if (!probe.ok) die(`连不上服务(HTTP ${probe.status})。确认地址是否正确:${endpoint}`);
  const m = await probe.json();

  await fs.mkdir(ANC_DIR, { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ endpoint, token, name }, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(green(`✓ 已连上。index 层 ${m.count} 个文件 / ${humanBytes(m.totalBytes)}`));
  console.log(`  配置写到 ${CONFIG_PATH}（权限 600，别 commit）`);
  console.log(`  下一步:${bold("anc pull")}`);
}

// ---------- pull ----------

async function cmdPull(argv) {
  const cfg = await loadConfig();
  const force = argv.includes("--force");
  const root = mirrorRoot(cfg);
  const local = await loadLocalManifest(cfg);

  const res = await api(cfg, "/manifest", {
    headers: local.etag && !force ? { "If-None-Match": local.etag } : {},
  });
  if (res.status === 304) {
    console.log(green("✓ 已是最新") + dim(`（${local.entries.length} 个文件）`));
    console.log(dim(`  ${root}`));
    return;
  }
  if (!res.ok) die(`拉 manifest 失败 HTTP ${res.status}`);
  const remote = await res.json();
  const remoteEtag = res.headers.get("etag");

  if (remote.truncated)
    console.log(yellow(`⚠️ manifest 被截断（扫描了 ${remote.stats.scannedKeys} 个键就触顶）——清单不完整`));

  const localMap = new Map(local.entries.map((e) => [e.path, e]));
  const remoteMap = new Map(remote.entries.map((e) => [e.path, e]));

  const toDownload = [];
  const conflicts = [];
  const failedDownloads = new Set();

  for (const e of remote.entries) {
    const l = localMap.get(e.path);
    if (!l) {
      // 清单里没有这条,但本地磁盘上**可能**已经有这个文件:比如你刚 anc push 完还没 pull,
      // 或者你先在本地新建了同名文件。直接下载会静默抹掉你手上的版本 —— 这是 lost update
      // 在客户端侧的翻版(服务端侧已由 base_etag 挡住)。所以先看盘上有没有。
      const onDisk = await readIfExists(path.join(root, e.path));
      if (onDisk) {
        const same = await sameAsRemote(cfg, e, onDisk);
        if (!same) {
          conflicts.push(e);
          continue;
        }
        // 内容一致(常见于 push 之后):只补登记,不重下
        e.localHash = sha256(onDisk);
        localMap.set(e.path, e);
        continue;
      }
      toDownload.push(e);
      continue;
    }
    if (l.etag === e.etag) continue; // 远端没变

    // 远端变了。本地有没有也被改过?改过就不能直接盖掉——写报告时这一步最要命。
    const localChanged = await hasLocalEdit(root, e.path, l);
    if (localChanged) conflicts.push(e);
    else toDownload.push(e);
  }

  // 本地改过但远端没变的:留着,提醒用户 push
  const localOnlyEdits = [];
  for (const l of local.entries) {
    const r = remoteMap.get(l.path);
    if (r && r.etag === l.etag && (await hasLocalEdit(root, l.path, l))) localOnlyEdits.push(l.path);
  }

  const toDelete = [];
  const removedWithLocalEdits = [];
  for (const l of local.entries.filter((entry) => !remoteMap.has(entry.path))) {
    if (await hasLocalEdit(root, l.path, l)) removedWithLocalEdits.push(l);
    else toDelete.push(l.path);
  }

  if (!toDownload.length && !toDelete.length && !conflicts.length) {
    console.log(green("✓ 无改动"));
  }

  // 下载
  let downloaded = 0;
  let bytes = 0;
  await pool(toDownload, DOWNLOAD_CONCURRENCY, async (e) => {
    const dest = path.join(root, e.path);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const r = await api(cfg, `/raw/${e.path.split("/").map(encodeURIComponent).join("/")}`);
    if (!r.ok) {
      console.error(red(`  ✗ ${e.path} HTTP ${r.status}`));
      failedDownloads.add(e.path);
      return;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    await fs.writeFile(dest, buf);
    e.localHash = sha256(buf);
    downloaded++;
    bytes += buf.length;
  });

  // 删除远端已不存在的
  for (const p of toDelete) {
    await fs.rm(path.join(root, p), { force: true });
  }

  // 冲突文件:远端版本另存为 .remote,本地原样保留,让人来合并
  for (const e of conflicts) {
    const r = await api(cfg, `/raw/${e.path.split("/").map(encodeURIComponent).join("/")}`);
    if (r.ok) await fs.writeFile(path.join(root, e.path + ".remote"), Buffer.from(await r.arrayBuffer()));
  }

  // 记状态。冲突项保留**本地**的旧 etag,这样下次 pull 还会再提示,直到人处理掉
  const newEntries = remote.entries.flatMap((e) => {
    if (conflicts.some((c) => c.path === e.path)) {
      const l = localMap.get(e.path);
      return l ? [{ ...l }] : [];
    }
    if (failedDownloads.has(e.path)) {
      const l = localMap.get(e.path);
      return l ? [{ ...l }] : [];
    }
    return [e];
  });
  newEntries.push(...removedWithLocalEdits);
  await fs.mkdir(stateDir(cfg), { recursive: true });
  await fs.writeFile(
    manifestPath(cfg),
    JSON.stringify(
      {
        etag: conflicts.length || failedDownloads.size || removedWithLocalEdits.length ? null : remoteEtag,
        entries: newEntries,
      },
      null,
      2,
    ) + "\n",
  );

  if (downloaded) console.log(green(`✓ 更新 ${downloaded} 个文件 (${humanBytes(bytes)})`));
  if (toDelete.length) console.log(green(`✓ 删除 ${toDelete.length} 个远端已移除的文件`));
  if (failedDownloads.size) {
    console.log(red(`\n⚠️ ${failedDownloads.size} 个文件下载失败，未标记为已同步：`));
    for (const p of failedDownloads) console.log(`    ${p}`);
    process.exitCode = 1;
  }
  if (removedWithLocalEdits.length) {
    console.log(yellow(`\n⚠️ ${removedWithLocalEdits.length} 个文件已从远端删除，但你的本地版本有未回传修改，已保留：`));
    for (const e of removedWithLocalEdits) console.log(`    ${e.path}`);
    console.log(dim("  确认后可重新 push，或手动删除本地文件。"));
  }
  if (localOnlyEdits.length) {
    console.log(yellow(`\n● 你本地改过但还没回传的 ${localOnlyEdits.length} 个文件:`));
    for (const p of localOnlyEdits.slice(0, 10)) console.log(`    ${p}`);
    console.log(dim(`  回传:anc push <文件>`));
  }
  if (conflicts.length) {
    console.log(red(`\n⚠️ ${conflicts.length} 个文件你我都改了（冲突，你的本地版本没有被覆盖）:`));
    for (const c of conflicts) {
      console.log(`    ${c.path}`);
      console.log(dim(`      对方的版本 → ${c.path}.remote`));
    }
    console.log(dim(`\n  解决:把 .remote 里对方的改动合进你的文件,然后`));
    console.log(dim(`    anc push <文件> --resolved --reason "合并了谁的什么"`));
    console.log(dim(`  （--resolved = 我已看过对方版本并合并完成;不加会因版本过期被拒）`));
  }
  console.log(dim(`\n  镜像根：${root}`));
  console.log(dim(`  agent 直接在这个目录 rg/grep，不用走网络`));
}

async function readIfExists(abs) {
  try {
    return await fs.readFile(abs);
  } catch {
    return null;
  }
}

/** 盘上这份与远端那份是不是同一内容(用于判断「未登记的本地文件」是冲突还是仅仅漏登记) */
async function sameAsRemote(cfg, entry, localBuf) {
  if (entry.size !== localBuf.length) return false;
  const r = await api(cfg, `/raw/${entry.path.split("/").map(encodeURIComponent).join("/")}`);
  if (!r.ok) return false;
  return Buffer.from(await r.arrayBuffer()).equals(localBuf);
}

/** 本地文件是否被人改过(与上次同步下来的内容不一致) */
async function hasLocalEdit(root, relPath, entry) {
  try {
    const buf = await fs.readFile(path.join(root, relPath));
    if (!entry.localHash) return false; // 没记过 hash,保守认为没改
    return sha256(buf) !== entry.localHash;
  } catch {
    return false; // 本地文件不在了,当作没改(会被重新下载)
  }
}

// ---------- status ----------

async function cmdStatus() {
  const cfg = await loadConfig();
  const root = mirrorRoot(cfg);
  const local = await loadLocalManifest(cfg);
  const res = await api(cfg, "/manifest");
  if (!res.ok) die(`拉 manifest 失败 HTTP ${res.status}`);
  const remote = await res.json();

  const localMap = new Map(local.entries.map((e) => [e.path, e]));
  const remoteMap = new Map(remote.entries.map((e) => [e.path, e]));

  const added = remote.entries.filter((e) => !localMap.has(e.path));
  const removed = local.entries.filter((e) => !remoteMap.has(e.path));
  const changed = [];
  const edited = [];
  for (const e of remote.entries) {
    const l = localMap.get(e.path);
    if (!l) continue;
    if (l.etag !== e.etag) changed.push(e.path);
    if (await hasLocalEdit(root, e.path, l)) edited.push(e.path);
  }

  console.log(bold(`${cfg.name} @ ${cfg.endpoint}`));
  console.log(`  index 层：远端 ${remote.count} 个 / ${humanBytes(remote.totalBytes)}，本地 ${local.entries.length} 个`);
  console.log(dim(`  服务端扫描 ${remote.stats.scannedKeys} 个键、${remote.stats.listCalls} 次 list`));
  const show = (label, arr, color) => {
    if (!arr.length) return;
    console.log(color(`\n  ${label} (${arr.length})`));
    for (const p of arr.slice(0, 20)) console.log(`    ${typeof p === "string" ? p : p.path}`);
    if (arr.length > 20) console.log(dim(`    …另有 ${arr.length - 20} 个`));
  };
  show("远端新增", added, green);
  show("远端更新", changed, green);
  show("远端删除", removed, yellow);
  show("你本地改过（未回传）", edited, yellow);
  if (!added.length && !changed.length && !removed.length && !edited.length)
    console.log(green("\n  ✓ 完全同步"));
  console.log(dim(`\n  镜像根：${root}`));
}

// ---------- open(按需取原件) ----------

async function cmdOpen(argv) {
  const cfg = await loadConfig();
  const vaultPath = argv.find((a) => !a.startsWith("--"));
  if (!vaultPath) die("用法:anc open <vault 里的原件路径> [--open]");

  const dest = path.join(originalsCache(cfg), vaultPath);
  const encoded = vaultPath.split("/").map(encodeURIComponent).join("/");

  // 已缓存且远端没变 → 直接用
  let existing = null;
  try {
    existing = await fs.stat(dest);
  } catch {}
  if (existing) {
    const head = await api(cfg, `/raw/${encoded}`, { method: "HEAD" });
    if (head.ok && Number(head.headers.get("content-length")) === existing.size) {
      console.log(green(`✓ 已在本地缓存`));
      console.log(dest);
      if (argv.includes("--open")) spawn("open", [dest], { detached: true, stdio: "ignore" }).unref();
      return;
    }
  }

  const res = await api(cfg, `/raw/${encoded}`);
  if (res.status === 404) die(`vault 里没有这个原件:${vaultPath}`);
  if (!res.ok) die(`下载失败 HTTP ${res.status}`);

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const total = Number(res.headers.get("content-length") ?? 0);
  process.stderr.write(dim(`  取 ${vaultPath}${total ? ` (${humanBytes(total)})` : ""} … `));
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  process.stderr.write(green("完成\n"));

  console.log(dest);
  if (argv.includes("--open")) spawn("open", [dest], { detached: true, stdio: "ignore" }).unref();
}

// ---------- push(回写) ----------

async function cmdPush(argv) {
  const cfg = await loadConfig();
  const args = argv.filter((a) => !a.startsWith("--"));
  const localPath = args[0];
  if (!localPath) die("用法:anc push <本地文件> [--as <vault 路径>] [--author 名字] [--reason 一句话]");

  const asIdx = argv.indexOf("--as");
  const root = mirrorRoot(cfg);
  const abs = path.resolve(localPath);
  let vaultPath = asIdx >= 0 ? argv[asIdx + 1] : path.relative(root, abs);
  if (vaultPath.startsWith(".."))
    die(`这个文件不在镜像目录里,请用 --as 指定它在 vault 中的路径。\n  镜像根:${root}`);
  vaultPath = vaultPath.split(path.sep).join("/");

  const authorIdx = argv.indexOf("--author");
  const reasonIdx = argv.indexOf("--reason");
  const author = authorIdx >= 0 ? argv[authorIdx + 1] : os.userInfo().username;
  const reason = reasonIdx >= 0 ? argv[reasonIdx + 1] : "";

  const buf = await fs.readFile(abs);
  const isText = /\.(md|markdown|json|jsonl|txt|yaml|yml|csv|toml|xml|html)$/i.test(vaultPath);

  if (!isText) {
    // 原件:流式 PUT,不经过模型也不经过 JSON。默认只允许新建(原件永不改动)
    const res = await api(cfg, `/raw/${vaultPath.split("/").map(encodeURIComponent).join("/")}`, {
      method: "PUT",
      body: buf,
      // header 值只能是 ByteString,中文作者名必须 percent-encode(服务端会解回来)
      headers: {
        "x-anc-author": encodeURIComponent(author),
        "x-anc-reason": encodeURIComponent(reason),
      },
    });
    if (res.status === 412) die((await res.text()).trim());
    if (!res.ok) die(`上传失败 HTTP ${res.status}:${(await res.text()).slice(0, 200)}`);
    console.log(green(`✓ 原件已上传 ${vaultPath} (${humanBytes(buf.length)})`));
    return;
  }

  // 文本:走 MCP vault_write —— 有历史存档,且强制 base_etag 防静默覆盖
  const local = await loadLocalManifest(cfg);
  const entry = local.entries.find((e) => e.path === vaultPath);
  let baseEtag = entry?.etag;

  // --resolved:「我已经看过对方的版本(.remote)并手工合并完了,以我这份为准」。
  // 没有这个出口的话,pull 遇冲突后本地 etag 永远是旧的 → push 永远被拒 → 用户卡死。
  // 它跟无脑覆盖的区别在于:必须是人明确声明合并完成,而不是默默用最新 etag 盖过去。
  if (argv.includes("--resolved")) {
    const cur = await mcp(cfg, "vault_read", { path: vaultPath });
    const nowEtag = cur.text.match(/\[vault-meta\][^\n]*etag=(\S+)/)?.[1];
    if (!nowEtag) die(`拿不到 ${vaultPath} 的当前版本,无法确认合并基线`);
    baseEtag = nowEtag;
  }

  const out = await mcp(cfg, "vault_write", {
    path: vaultPath,
    content: buf.toString("utf8"),
    ...(baseEtag ? { base_etag: baseEtag } : {}),
    author,
    reason,
  });
  if (out.isError) {
    console.error(red(`✗ ${out.text}`));
    console.error(dim(`  提示:先跑 anc pull 拿最新版,合并你的改动后再 push`));
    process.exit(1);
  }
  // 立刻把新 etag 记进本地清单。不记的话,下次 pull 会把这个文件当「远端新增」直接下载,
  // 静默盖掉你手上的版本 —— 服务端已经用 base_etag 挡住了写入侧的 lost update,
  // 客户端这一侧必须自己补上,否则同一个洞换个地方出现。
  const newEtag = out.text.match(/\[vault-meta\][^\n]*etag=(\S+)/)?.[1];
  if (newEtag) {
    const idx = local.entries.findIndex((e) => e.path === vaultPath);
    const rec = { path: vaultPath, etag: newEtag, size: buf.length, localHash: sha256(buf) };
    if (idx >= 0) local.entries[idx] = rec;
    else local.entries.push(rec);
    await fs.mkdir(stateDir(cfg), { recursive: true });
    // 整体 etag 置空:别人可能同时改了别的文件,下次 pull 要真拉一次而不是 304
    await fs.writeFile(
      manifestPath(cfg),
      JSON.stringify({ etag: null, entries: local.entries }, null, 2) + "\n",
    );
  }
  // 冲突已随本次写入解决,清掉留在盘上的对方版本副本
  await fs.rm(path.join(root, vaultPath + ".remote"), { force: true }).catch(() => {});
  console.log(green(`✓ ${out.text.split("\n")[0]}`));
}

// ---------- where ----------

async function cmdWhere() {
  const cfg = await loadConfig();
  console.log(mirrorRoot(cfg));
}

// ---------- main ----------

const [, , cmd, ...rest] = process.argv;
const commands = {
  init: cmdInit,
  pull: cmdPull,
  status: cmdStatus,
  open: cmdOpen,
  push: cmdPush,
  where: cmdWhere,
};

if (!cmd || cmd === "-h" || cmd === "--help" || !commands[cmd]) {
  console.log(`anc — 公司共享 vault 本地镜像

  anc init <endpoint> <token> --name <公司名>   连上公司 vault
  anc pull                                      增量同步(只同步 md/OCR 层,不碰 GB 原件)
  anc status                                    看差异,不改任何东西
  anc open <vault路径> [--open]                 按需取一份原件
  anc push <文件> [--as <vault路径>] [--resolved] 回写(文本留历史+防覆盖,原件流式直传)
  anc where                                     打印本地镜像根目录

pull 遇到「你我都改了」时不会覆盖你的版本,对方那份会存成 <文件>.remote;
你合并完之后用 anc push --resolved 提交。

同步的是 index 层(结构化 md + OCR 文本);原件留在云上按需取。
本地镜像可以直接 rg/grep —— 比服务端搜索快,而且不会截断。`);
  process.exit(cmd && !commands[cmd] ? 1 : 0);
}

commands[cmd](rest).catch((e) => die(e?.stack ?? String(e)));
