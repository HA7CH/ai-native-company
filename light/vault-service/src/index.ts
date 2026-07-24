/**
 * anc-vault — 公司共享 vault 服务(轻形态 MVP)
 *
 * 一个 Cloudflare Worker + R2:全公司唯一一份文件(markdown / PDF / JSON 混存),
 * 以 MCP(streamable HTTP,无状态)暴露五个工具:list / read / search / write / history。
 * 每人的 Claude Code 一行接入:
 *   claude mcp add --transport http vault https://<worker>/mcp --header "Authorization: Bearer <token>"
 *
 * 设计约束:
 * - 零运行时依赖,协议手写(MCP 2025-06-18 无状态子集:POST JSON-RPC,响应 application/json)
 * - 写入自动留版本:旧内容先复制到 _history/<path>/<ts>-<rand>,正本用 etag CAS 防并发丢版本
 * - _history/ 前缀只读(工具层拒写),是审计与回滚的底
 * - 鉴权:Bearer token(VAULT_TOKEN secret);未配置该 secret 时拒绝一切请求(默认值即安全)
 */

import UI_HTML from "./ui.html";

export interface Env {
  VAULT: R2Bucket;
  VAULT_TOKEN?: string;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "anc-vault", version: "0.1.0" };
const HISTORY_PREFIX = "_history/";
// "0" 紧跟 "/" 之后:startAfter 用它一步跳过整个 _history/ 字典序区间
const HISTORY_REGION_END = "_history0";

const INSTRUCTIONS = `这是本公司的共享 vault(唯一真相源)。使用纪律:
1. 回答公司事实前,先 vault_read("CLAUDE.md") 拿路由表,按表定位文件;拿不准先 vault_list 该目录。
2. 诚实条款:vault 里查不到的,就明确说「尚未入库」,绝不凭训练记忆补。
3. 写入前先读 CONTRIBUTING.md 的入库规范;每次写入给 author 和 reason,系统自动留历史版本。
4. 易变事实(名单/日程/口径)只在 canonical 文件单点维护,引用不复述。`;

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: "vault_list",
    description:
      "列出 vault 某目录下的文件和子目录(类似 ls)。path 省略时列根目录。Use to browse the company vault. 触发词:列目录、看看有什么、browse vault。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径,如 'projects/'。省略 = 根目录" },
      },
    },
  },
  {
    name: "vault_read",
    description:
      "读取 vault 中一个文本文件的全文(markdown/JSON/txt 等)。回答公司事实前先读 CLAUDE.md 拿路由。二进制文件(PDF/图片)只返回元信息。触发词:读文件、查一下、read file。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径,如 'company/profile.md'" } },
      required: ["path"],
    },
  },
  {
    name: "vault_search",
    description:
      "在 vault 的文本文件里按字面子串(不区分大小写)搜索,返回 文件:行号:行内容。优先用 CLAUDE.md 路由表定位,搜索是兜底。历史存档默认不搜,显式传 path='_history/…' 可搜。触发词:搜、grep、search vault。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的字面文本" },
        path: { type: "string", description: "限定目录前缀,省略 = 全库(不含历史存档)" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_write",
    description:
      "写入/覆盖 vault 中的一个文件。旧版本自动存档到 _history/,可回滚;他人同时改过会报冲突(重读合并后再写)。文本用 content;二进制(PDF 等原件)用 content_base64。写前先读 CONTRIBUTING.md 规范。触发词:入库、保存、更新文件。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标路径,如 'clients/acme.md'" },
        content: { type: "string", description: "文本内容(与 content_base64 二选一)" },
        content_base64: { type: "string", description: "base64 编码的二进制内容(≤6MB)" },
        author: { type: "string", description: "写入者名字(记入历史)" },
        reason: { type: "string", description: "一句话:为什么改(记入历史)" },
      },
      required: ["path"],
    },
  },
  {
    name: "vault_history",
    description:
      "查看某文件的历史版本列表(新→旧:时间、大小、谁替换的、为什么);配合 vault_read 读历史版本内容可回滚。触发词:历史、谁改的、回滚。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
  },
];

// ---------- 路径与内容约束 ----------

const TEXT_EXT = /\.(md|markdown|json|jsonl|txt|yaml|yml|csv|toml|xml|html)$/i;
const MAX_WRITE_BYTES = 6 * 1024 * 1024; // 单文件上限
const MAX_READ_BYTES = 2 * 1024 * 1024; // 单次读取上限
const SEARCH_MAX_FILES = 400; // 单次搜索最多扫描的文件数
const SEARCH_MAX_TOTAL = 15 * 1024 * 1024; // 单次搜索最多读的总字节
const SEARCH_MAX_HITS = 100;
const LIST_MAX_ENTRIES = 1000;
const HISTORY_MAX_SHOWN = 100;

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 127) return true;
  }
  return false;
}

function normalizePath(raw: string, { forWrite = false } = {}): string {
  // 尾随 / 一律剥掉:目录语义由调用方补回(工具描述示例就带 '/',不能拒)
  const p = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (p.length === 0 || p.length > 512) throw new Error("路径为空或过长");
  if (p.split("/").some((seg) => seg === "." || seg === ".." || seg === ""))
    throw new Error("路径不允许包含 . / .. / 空段");
  if (hasControlChar(p)) throw new Error("路径包含控制字符");
  if (forWrite && (p === "_history" || p.startsWith(HISTORY_PREFIX)))
    throw new Error("_history/ 为只读存档区,不允许直接写入");
  return p;
}

/** _history/<orig>/<ts> → <orig>;非历史 key 返回 null */
function historyOriginal(key: string): string | null {
  if (!key.startsWith(HISTORY_PREFIX)) return null;
  const rest = key.slice(HISTORY_PREFIX.length);
  const i = rest.lastIndexOf("/");
  return i > 0 ? rest.slice(0, i) : null;
}

function isTextPath(p: string): boolean {
  const effective = historyOriginal(p) ?? p; // 历史存档按原文件路径判文本性,防把 PDF 存档当文本
  return TEXT_EXT.test(effective) || !/\.[a-z0-9]+$/i.test(effective); // 无扩展名按文本处理
}

// ---------- 工具实现 ----------

async function toolList(env: Env, args: { path?: string }): Promise<string> {
  const prefix = args.path ? normalizePath(args.path) + "/" : "";
  const dirs = new Set<string>();
  const files: string[] = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const page = await env.VAULT.list({ prefix, delimiter: "/", cursor, limit: 500 });
    for (const d of page.delimitedPrefixes) dirs.add(d);
    for (const o of page.objects) files.push(`${o.key}  (${o.size} B)`);
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor && dirs.size + files.length >= LIST_MAX_ENTRIES) {
      truncated = true;
      cursor = undefined;
    }
  } while (cursor);
  if (dirs.size === 0 && files.length === 0)
    return prefix ? `目录为空或不存在:${prefix}` : "vault 为空(先跑 anc-onboard 建库)";
  const dirLines = [...dirs].filter((d) => d !== HISTORY_PREFIX).map((d) => `${d}  <目录>`);
  const out = [...dirLines, ...files];
  if (truncated) out.push(`(已截断:条目超过 ${LIST_MAX_ENTRIES},请指定子目录再 vault_list)`);
  return out.join("\n");
}

async function toolRead(env: Env, args: { path: string }): Promise<string> {
  const path = normalizePath(args.path);
  const obj = await env.VAULT.get(path);
  if (!obj) return `未找到:${path}(用 vault_list 确认路径;查不到的事实请如实说「尚未入库」)`;
  if (!isTextPath(path))
    return `[二进制文件] ${path},${obj.size} B,uploaded ${obj.uploaded.toISOString()}。原件不支持在线读取,相应的结构化 markdown 应在同目录或其上级(见 source_file 约定)。`;
  if (obj.size > MAX_READ_BYTES) return `文件过大(${obj.size} B > ${MAX_READ_BYTES}),请拆分或用 vault_search 定位片段`;
  return await obj.text();
}

async function toolSearch(env: Env, args: { query: string; path?: string }): Promise<string> {
  const query = (args.query ?? "").trim();
  if (!query) throw new Error("query 不能为空");
  const q = query.toLowerCase();
  const prefix = args.path ? normalizePath(args.path) + "/" : "";
  const includeHistory = prefix.startsWith(HISTORY_PREFIX); // 显式搜历史时不排除
  const hits: string[] = [];
  let scanned = 0;
  let totalBytes = 0;
  let truncated = false;
  let cursor: string | undefined;
  let startAfter: string | undefined;
  scan: while (true) {
    const page = await env.VAULT.list(
      cursor ? { prefix, cursor, limit: 500 } : { prefix, startAfter, limit: 500 },
    );
    startAfter = undefined;
    let jumpHistory = false;
    for (const o of page.objects) {
      if (!includeHistory && o.key.startsWith(HISTORY_PREFIX)) {
        // 字典序已进入历史区:丢弃本页剩余,用 startAfter 一步跳过整个区间(防 _history 无限增长拖垮全库搜索)
        jumpHistory = true;
        break;
      }
      if (!isTextPath(o.key)) continue;
      if (scanned >= SEARCH_MAX_FILES || totalBytes + o.size > SEARCH_MAX_TOTAL) {
        truncated = true;
        break scan;
      }
      scanned++;
      totalBytes += o.size;
      const body = await env.VAULT.get(o.key);
      if (!body) continue;
      const lines = (await body.text()).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          hits.push(`${o.key}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= SEARCH_MAX_HITS) {
            truncated = true;
            break scan;
          }
        }
      }
    }
    if (jumpHistory) {
      cursor = undefined;
      startAfter = HISTORY_REGION_END;
      continue;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }
  const head = `「${query}」命中 ${hits.length} 行(扫描 ${scanned} 个文件${truncated ? ",已截断,建议加 path 缩小范围" : ""})`;
  return hits.length ? `${head}\n${hits.join("\n")}` : head;
}

async function toolWrite(
  env: Env,
  args: { path: string; content?: string; content_base64?: string; author?: string; reason?: string },
): Promise<string> {
  const path = normalizePath(args.path, { forWrite: true });
  if ((args.content == null) === (args.content_base64 == null))
    throw new Error("content 与 content_base64 必须恰好提供一个");
  let body: ArrayBuffer | string;
  if (args.content_base64 != null) {
    const bin = Uint8Array.from(atob(args.content_base64.replace(/\s/g, "")), (c) => c.charCodeAt(0));
    if (bin.byteLength > MAX_WRITE_BYTES) throw new Error(`超过单文件上限 ${MAX_WRITE_BYTES} B`);
    body = bin.buffer as ArrayBuffer;
  } else {
    if (new TextEncoder().encode(args.content!).byteLength > MAX_WRITE_BYTES)
      throw new Error(`超过单文件上限 ${MAX_WRITE_BYTES} B`);
    body = args.content!;
  }
  const meta = { author: args.author ?? "unknown", reason: args.reason ?? "" };
  const size = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body.byteLength;
  const conflictMsg = "并发写冲突:该文件刚被他人修改。请重新 vault_read 最新内容,合并你的改动后再写";

  const prev = await env.VAULT.get(path);
  if (!prev) {
    // 新建:onlyIf etagDoesNotMatch "*" = 仅当不存在时写入,防两个并发新建互相无痕覆盖
    const res = await env.VAULT.put(path, body, { customMetadata: meta, onlyIf: { etagDoesNotMatch: "*" } });
    if (!res) throw new Error(conflictMsg);
    return `已写入 ${path}(${size} B,新建)`;
  }
  // 覆盖:先存档旧版,再用 etag CAS 写正本;CAS 失败(他人先写入)则回收存档并报冲突
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 6); // 同毫秒双写防存档 key 相撞
  const histKey = `${HISTORY_PREFIX}${path}/${ts}-${rand}`;
  await env.VAULT.put(histKey, await prev.arrayBuffer(), {
    customMetadata: { ...meta, replacedAt: ts },
  });
  const res = await env.VAULT.put(path, body, { customMetadata: meta, onlyIf: { etagMatches: prev.etag } });
  if (!res) {
    await env.VAULT.delete(histKey);
    throw new Error(conflictMsg);
  }
  return `已写入 ${path}(${size} B,旧版已存档 ${histKey})`;
}

async function toolHistory(env: Env, args: { path: string }): Promise<string> {
  const path = normalizePath(args.path);
  const prefix = `${HISTORY_PREFIX}${path}/`;
  const versions: { key: string; size: number; meta: Record<string, string> }[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let overflow = false;
  do {
    const page = await env.VAULT.list({ prefix, cursor, limit: 500, include: ["customMetadata"] });
    for (const o of page.objects) {
      // 排除子路径文件的历史(R2 扁平命名空间:文件 a 与 a/x.md 可并存)
      if (o.key.slice(prefix.length).includes("/")) continue;
      versions.push({ key: o.key, size: o.size, meta: (o.customMetadata as Record<string, string>) ?? {} });
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor && ++pages >= 40) {
      overflow = true;
      cursor = undefined;
    }
  } while (cursor);
  if (versions.length === 0) return `${path} 没有历史版本(从未被覆盖过)`;
  // key 含定宽时间戳,字典序 = 时间序(旧→新);展示新→旧
  const shown = versions.slice(-HISTORY_MAX_SHOWN).reverse();
  const lines = shown.map(
    (v) => `${v.key}  ${v.size} B  替换者=${v.meta.author ?? "?"}  原因=${v.meta.reason ?? ""}`,
  );
  const head =
    `历史版本共 ${versions.length}${overflow ? "+" : ""} 个,显示最近 ${shown.length} 个(新→旧)。` +
    `用 vault_read 读任意一版,内容写回原路径即回滚:`;
  return `${head}\n${lines.join("\n")}`;
}

// ---------- MCP JSON-RPC(无状态 streamable HTTP)----------

type RpcMessage = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any };

function rpcResult(id: number | string | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: number | string | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(msg: RpcMessage, env: Env): Promise<object | null> {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg))
    return rpcError(null, -32600, "invalid request"); // body 为 null / 非对象也必须回 JSON-RPC 错误,不能 500
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const name = params?.name as string;
        const args = params?.arguments ?? {};
        const impl: Record<string, (e: Env, a: any) => Promise<string>> = {
          vault_list: toolList,
          vault_read: toolRead,
          vault_search: toolSearch,
          vault_write: toolWrite,
          vault_history: toolHistory,
        };
        if (!impl[name]) return rpcError(id, -32602, `未知工具:${name}`);
        try {
          const text = await impl[name](env, args);
          return rpcResult(id, { content: [{ type: "text", text }], isError: false });
        } catch (e: any) {
          return rpcResult(id, { content: [{ type: "text", text: `错误:${e?.message ?? e}` }], isError: true });
        }
      }
      default:
        if (isNotification) return null; // notifications/initialized 等:无响应体
        return rpcError(id, -32601, `不支持的方法:${method}`);
    }
  } catch (e: any) {
    return isNotification ? null : rpcError(id, -32603, `内部错误:${e?.message ?? e}`);
  }
}

function authorized(req: Request, env: Env): boolean {
  if (!env.VAULT_TOKEN) return false; // 未配 token = 全拒,绝不默认裸奔
  const got = req.headers.get("Authorization") ?? "";
  const want = `Bearer ${env.VAULT_TOKEN}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

const RAW_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
  pdf: "application/pdf", md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
  json: "application/json", html: "text/plain; charset=utf-8", // html 一律按纯文本出,防存储型 XSS
};

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/" && req.method === "GET")
      return new Response(UI_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    // GET /raw/<key>:网页端预览/下载二进制(logo/PDF)用;同 Bearer 鉴权
    if (url.pathname.startsWith("/raw/") && req.method === "GET") {
      if (!authorized(req, env)) return new Response("unauthorized", { status: 401 });
      let key: string;
      try {
        key = normalizePath(decodeURIComponent(url.pathname.slice("/raw/".length)));
      } catch (e: any) {
        return new Response(`bad path: ${e?.message ?? e}`, { status: 400 });
      }
      const obj = await env.VAULT.get(key);
      if (!obj) return new Response("not found", { status: 404 });
      const ext = (key.split(".").pop() ?? "").toLowerCase();
      return new Response(obj.body, {
        status: 200,
        headers: {
          "content-type": RAW_TYPES[ext] ?? "application/octet-stream",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(key.split("/").pop() ?? "file")}`,
        },
      });
    }
    if (url.pathname !== "/mcp") return new Response("not found", { status: 404 });
    if (req.method === "GET") return new Response("stateless server: no event stream", { status: 405 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (!authorized(req, env))
      return new Response(JSON.stringify(rpcError(null, -32000, "unauthorized")), {
        status: 401,
        headers: { "content-type": "application/json" },
      });

    let parsed: unknown;
    try {
      parsed = await req.json();
    } catch {
      return new Response(JSON.stringify(rpcError(null, -32700, "parse error")), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const messages: RpcMessage[] = Array.isArray(parsed) ? (parsed as RpcMessage[]) : [parsed as RpcMessage];
    const responses = (await Promise.all(messages.map((m) => handleRpc(m, env)))).filter((r) => r !== null);
    if (responses.length === 0) return new Response(null, { status: 202 }); // 纯 notification
    const body = Array.isArray(parsed) ? responses : responses[0];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  },
};
