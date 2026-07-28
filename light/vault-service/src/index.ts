/**
 * anc-vault — 公司共享 vault 服务(分层轻形态 v2)
 *
 * 一个 Cloudflare Worker + R2,给全公司提供唯一一份 vault。v2 的核心裁决:
 *
 *   **MCP 是控制面,不是数据通道。字节流走独立 HTTP 面,agent 读本地镜像。**
 *
 * 由来(实测,非推演):真实会计师事务所 vault 4.4 GB / 1221 个原件,其中结构化
 * markdown 只有 359 KB —— 占 0.008%。而 MCP 的参数是模型逐 token 生成的字符串,
 * 一个 4.4 MB 文件 = 587 万 base64 字符 ≈ 150 万 token 输出,物理搬不动;agent
 * 内联上限实测约 100–150 KB。所以「让 agent 通过 MCP 读写整个 vault」这条路
 * 在体量上限那里是死的,与 Worker 写得好不好无关。
 *
 * v2 因此把 vault 按「访问模式」分层,各走各的通道:
 *
 *   index 层   结构化 md + OCR 文本   MB 级   /manifest 增量同步到本地 → agent 用 rg 全速搜
 *   originals  原件(PDF/扫描件/影像)  GB 级   /raw 流式按需单取,永不全量同步
 *   history    覆盖写的旧版存档              只读,不同步
 *
 * 三条接口分工:
 *   GET  /manifest   列 index 层的 {path, etag, size} —— 只 list 不读内容,给 `anc pull` 做增量 diff
 *   GET  /raw/<path> 流式透传 R2 对象(支持 Range / If-None-Match)—— Worker 内存恒定,GB 无压力
 *   PUT  /raw/<path> 流式写入 —— 原件只允许新建(铁律:原件永不改动)
 *   POST /mcp        MCP 控制面:list / read / search / write / history / original
 *
 * 设计约束:
 * - 零运行时依赖,协议手写(MCP 2025-06-18 无状态子集:POST JSON-RPC,响应 application/json)
 * - 写入自动留版本:旧内容先复制到 _history/<path>/<ts>-<rand>
 * - 覆盖写强制 read-before-write:必须带 base_etag,否则拒写(v1 的 CAS 窗口只有毫秒,
 *   「上午读、下午写」会静默覆盖他人改动且双方零提示 —— 这在多人改同一份报告时必然烂账)
 * - _history/ 前缀只读(工具层拒写),是审计与回滚的底
 * - 鉴权:Bearer token(VAULT_TOKEN secret);未配置该 secret 时拒绝一切请求(默认值即安全)
 */

export interface Env {
  VAULT: R2Bucket;
  VAULT_TOKEN?: string;
}

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "anc-vault", version: "0.2.0" };
const HISTORY_PREFIX = "_history/";
// "0" 紧跟 "/" 之后:startAfter 用它一步跳过整个 _history/ 字典序区间
const HISTORY_REGION_END = "_history0";
const ORIGINALS_DIR = "_originals";

const INSTRUCTIONS = `这是本公司的共享 vault(唯一真相源)。使用纪律:

1. 回答公司事实前,先 vault_read("CLAUDE.md") 拿路由表,按表定位文件;拿不准先 vault_list 该目录。
2. 诚实条款:vault 里查不到的,就明确说「尚未入库」,绝不凭训练记忆补。
3. **搜索结果永远只是样本**,不能用它证明「没有」「全部一致」「已核对完」。要完备性 →
   vault_list 枚举 + 逐个 vault_read。永远带 path 前缀搜索,这是正确性要求不是优化。
4. **改已有文件必须先 vault_read 拿 etag,再作为 base_etag 传给 vault_write**;
   不带 base_etag 的覆盖写会被拒绝(防止静默覆盖他人改动)。
5. **原件不经你搬运**:PDF/扫描件/影像用 vault_original 拿直链,再用 curl 下到本地解析。
   绝不尝试把二进制 base64 内联进工具参数——体量上物理不可能。
6. 装了 anc CLI 的话,本地 \`anc pull\` 出来的镜像可以直接用 rg/grep 全速搜,
   比 vault_search 快且无截断。vault_search 是没装 CLI 时的兜底。`;

// ---------- 分层 ----------

const TEXT_EXT = /\.(md|markdown|json|jsonl|txt|yaml|yml|csv|toml|xml|html)$/i;

type Layer = "index" | "originals" | "history" | "blob";

/**
 * 决定一个 key 属于哪一层。规则贴合真实 vault 的目录形态:
 * `_originals/` 是**嵌套在各项目目录里**的(projects/<项目>/_originals/…),不是顶层前缀,
 * 所以按路径片段判断而不是按前缀判断。
 *
 * - history   : _history/ 开头
 * - originals : 路径中任一层目录名为 _originals
 * - index     : 其余的文本文件(含 <项目>/_ocr/ 下的 OCR 产物)—— 这一层会被同步到本地
 * - blob      : 其余的二进制(如「交付/」里的 xlsx/docx)—— 按需取,不同步
 */
function layerOf(key: string): Layer {
  if (key === "_history" || key.startsWith(HISTORY_PREFIX)) return "history";
  if (key.split("/").includes(ORIGINALS_DIR)) return "originals";
  return TEXT_EXT.test(key) || !/\.[a-z0-9]+$/i.test(key) ? "index" : "blob";
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

// ---------- 路径与内容约束 ----------

const MAX_WRITE_BYTES = 1 * 1024 * 1024; // MCP 单文本写入上限(v1 是 6MB,但 agent 实测搬不动那么多;
//                                           且 >1MB 的文本文件会拖垮所在子树的搜索)
const MAX_READ_BYTES = 2 * 1024 * 1024; // 单次读取上限
const SEARCH_MAX_FILES = 400; // 单次搜索最多扫描的文件数
const SEARCH_MAX_TOTAL = 15 * 1024 * 1024; // 单次搜索最多读的总字节
const SEARCH_MAX_FILE_BYTES = 1 * 1024 * 1024; // 单个文件超过它就跳过(而不是终止整个扫描)
const SEARCH_MAX_HITS = 200; // 展示的总行数上限
const SEARCH_PER_FILE_HITS = 5; // 每个文件最多展示几行 —— 保证命中面覆盖广度,而不是被一个文件吃满
const LIST_MAX_ENTRIES = 1000;
const HISTORY_MAX_SHOWN = 100;
const MANIFEST_MAX_LIST_CALLS = 200; // 每次 list 取 1000 个键 → 上限约 20 万个键

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

// ---------- 工具定义 ----------

const TOOLS = [
  {
    name: "vault_list",
    description:
      "列出 vault 某目录下的文件和子目录(类似 ls)。path 省略时列根目录。" +
      "带尾随斜杠('projects/')= 目录模式;不带斜杠且该目录不存在时自动退回前缀模式" +
      "('projects/2025-' 可列出所有 2025 开头的项目)。触发词:列目录、看看有什么、browse vault。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目录路径('projects/')或名称前缀('projects/2025-')。省略 = 根目录" },
      },
    },
  },
  {
    name: "vault_read",
    description:
      "读取 vault 中一个文本文件的全文(markdown/JSON/txt 等),并返回该文件当前 etag。" +
      "**要改这个文件,必须把返回的 etag 作为 base_etag 传给 vault_write**。" +
      "回答公司事实前先读 CLAUDE.md 拿路由。原件(PDF/扫描件/影像)请改用 vault_original。" +
      "触发词:读文件、查一下、read file。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径,如 'company/主数据.md'" } },
      required: ["path"],
    },
  },
  {
    name: "vault_search",
    description:
      "在 vault 的文本文件里按字面子串(不区分大小写)搜索,返回 文件:行号:行内容。" +
      "**结果永远只是样本,不能用来证明「没有」或「已核对完」**;要完备性请 vault_list 枚举后逐个 vault_read。" +
      "务必带 path 缩小范围。扫描件原件没有文字层,搜不到内容属正常——那要先跑 OCR。" +
      "触发词:搜、grep、search vault。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要搜索的字面文本" },
        path: { type: "string", description: "限定目录前缀,强烈建议提供;省略 = 全库(不含历史存档)" },
      },
      required: ["query"],
    },
  },
  {
    name: "vault_write",
    description:
      "写入/覆盖 vault 中的一个**文本**文件(markdown/json/txt)。" +
      "**覆盖已有文件必须先 vault_read 拿到 etag,并作为 base_etag 传入**,否则拒写——" +
      "这是防止你覆盖掉别人在你读完之后做的改动(旧版会静默丢失且双方无提示)。" +
      "新建文件不传 base_etag。每次覆盖旧版自动存档到 _history/(可查可回滚)。" +
      "二进制/原件不走本工具(体量上搬不动),用 anc CLI 或 PUT /raw 上传。" +
      "触发词:入库、保存、更新文件。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标路径,如 'projects/2025-x/overview.md'" },
        content: { type: "string", description: "文本内容" },
        base_etag: {
          type: "string",
          description: "你此前 vault_read 该文件时返回的 etag。覆盖已有文件时必填;新建时省略",
        },
        author: { type: "string", description: "写入者名字(记入历史)" },
        reason: { type: "string", description: "一句话:为什么改(记入历史)" },
      },
      required: ["path", "content"],
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
  {
    name: "vault_original",
    description:
      "取原件(PDF / 扫描件 / 影像 / Excel / Word)的下载直链与元信息。" +
      "**原件不经你搬运**——本工具只给一条 curl 命令,你在本地终端执行把文件下下来再解析。" +
      "同时会告诉你该原件有没有对应的 OCR 文本(有的话直接读那个更快)。" +
      "触发词:调原件、看扫描件、下载 PDF、核对原件、原件在哪。",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "原件路径,如 'projects/2025-x/_originals/A3业务约定书/合同.pdf'" } },
      required: ["path"],
    },
  },
];

// ---------- 工具实现 ----------

/** 工具返回值:纯文本,或正文 + 附加元信息块(分成两个 content block,避免元信息污染正文) */
type ToolOut = string | { text: string; extra: string };

interface ToolCtx {
  env: Env;
  origin: string; // 形如 https://vault.example.com,用于拼 /raw 直链
}

async function toolList(ctx: ToolCtx, args: { path?: string }): Promise<string> {
  const raw = (args.path ?? "").trim();
  if (!raw) return await listByPrefix(ctx.env, "", "根目录");

  // v1 bug:normalizePath 剥掉尾随 '/' 后又无条件补回,导致 vault_list("projects/2025-")
  // 变成前缀 "projects/2025-/" 而永远返回「目录为空」。这里区分两种意图:
  //   带尾随斜杠 → 目录模式;不带 → 先试目录,空了再退回前缀模式。
  const explicitDir = /\/$/.test(raw);
  const p = normalizePath(raw);
  const asDir = await listByPrefix(ctx.env, p + "/", p + "/");
  if (explicitDir || !asDir.startsWith("目录为空")) return asDir;

  const asPrefix = await listByPrefix(ctx.env, p, `名称前缀 ${p}`);
  if (asPrefix.startsWith("目录为空")) return `未找到目录或前缀:${p}`;
  return `(「${p}」不是目录,按名称前缀列出)\n${asPrefix}`;
}

async function listByPrefix(env: Env, prefix: string, label: string): Promise<string> {
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
  if (dirs.size === 0 && files.length === 0) return `目录为空或不存在:${label}`;
  const dirLines = [...dirs].filter((d) => d !== HISTORY_PREFIX).map((d) => `${d}  <目录>`);
  const out = [...dirLines, ...files];
  if (truncated) out.push(`(已截断:条目超过 ${LIST_MAX_ENTRIES},请指定子目录再 vault_list)`);
  return out.join("\n");
}

async function toolRead(ctx: ToolCtx, args: { path: string }): Promise<ToolOut> {
  const path = normalizePath(args.path);
  const obj = await ctx.env.VAULT.get(path);
  if (!obj) return `未找到:${path}(用 vault_list 确认路径;查不到的事实请如实说「尚未入库」)`;
  if (!isTextPath(path))
    return (
      `[原件·非文本] ${path},${obj.size} B,上传 ${obj.uploaded.toISOString()}。\n` +
      `原件不经模型搬运:用 vault_original("${path}") 拿下载直链,或读它的 OCR 文本(如已生成)。`
    );
  if (obj.size > MAX_READ_BYTES)
    return `文件过大(${obj.size} B > ${MAX_READ_BYTES}),请拆分,或用 vault_search 定位片段后读取相邻文件`;
  return {
    text: await obj.text(),
    extra: `[vault-meta] path=${path} etag=${obj.etag} size=${obj.size}\n要修改本文件:把 etag 原样作为 base_etag 传给 vault_write(不传会被拒写)。`,
  };
}

async function toolSearch(ctx: ToolCtx, args: { query: string; path?: string }): Promise<string> {
  const env = ctx.env;
  const query = (args.query ?? "").trim();
  if (!query) throw new Error("query 不能为空");
  const q = query.toLowerCase();
  const prefix = args.path ? normalizePath(args.path) + "/" : "";
  const includeHistory = prefix.startsWith(HISTORY_PREFIX); // 显式搜历史时不排除

  const perFile: { key: string; lines: string[]; more: number }[] = [];
  const skippedBig: string[] = [];
  let scanned = 0;
  let totalBytes = 0;
  let totalHitLines = 0;
  let budgetExhausted = false;
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

      // v1 bug:单个大文件会 `break scan` 终止整个扫描 —— 一个 20MB 的 csv 丢进目录,
      // 此后该目录**任何**搜索永远返回 0 命中,且只在结果头部一行提示。改成跳过并列名。
      if (o.size > SEARCH_MAX_FILE_BYTES) {
        skippedBig.push(`${o.key}(${o.size} B)`);
        continue;
      }
      if (scanned >= SEARCH_MAX_FILES || totalBytes + o.size > SEARCH_MAX_TOTAL) {
        budgetExhausted = true;
        break scan;
      }
      scanned++;
      totalBytes += o.size;
      const body = await env.VAULT.get(o.key);
      if (!body) continue;
      const lines = (await body.text()).split("\n");
      const picked: string[] = [];
      let fileHits = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(q)) continue;
        fileHits++;
        // 每个文件只展示前 N 行:v1 是全局 100 行封顶,一份 336 行底稿就能吃满,
        // 后面所有文件一个字都不会被扫到。改成按文件配额,保证命中**面**是完整的。
        if (picked.length < SEARCH_PER_FILE_HITS && totalHitLines < SEARCH_MAX_HITS) {
          picked.push(`${o.key}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          totalHitLines++;
        }
      }
      if (fileHits > 0) perFile.push({ key: o.key, lines: picked, more: fileHits - picked.length });
    }
    if (jumpHistory) {
      cursor = undefined;
      startAfter = HISTORY_REGION_END;
      continue;
    }
    if (!page.truncated) break;
    cursor = page.cursor;
  }

  const totalFiles = perFile.length;
  const totalLines = perFile.reduce((n, f) => n + f.lines.length + f.more, 0);
  const head =
    `「${query}」命中 ${totalFiles} 个文件 / 约 ${totalLines} 行` +
    `(已扫描 ${scanned} 个文本文件${prefix ? `,范围 ${prefix}` : ",全库"})`;

  const body = perFile.map((f) => f.lines.join("\n") + (f.more > 0 ? `\n  … 该文件另有 ${f.more} 行命中未展示` : ""));

  const notes: string[] = [];
  if (budgetExhausted)
    notes.push(
      `⚠️ 扫描预算耗尽(已扫 ${scanned} 文件 / ${totalBytes} B),**后面的文件没有被搜索**。` +
        `结果不完整,请用 path 缩小范围重搜。`,
    );
  if (skippedBig.length)
    notes.push(`⚠️ 以下文件超过单文件上限被跳过(未被搜索):${skippedBig.join("、")}`);
  if (totalHitLines >= SEARCH_MAX_HITS)
    notes.push(`ℹ️ 展示行数已达上限 ${SEARCH_MAX_HITS};命中文件数是完整的,行内容有省略。`);
  notes.push(`ℹ️ 搜索结果是样本,不能据此断言「没有」或「已全部核对」。扫描件无文字层时搜不到属正常(需先 OCR)。`);

  if (totalFiles === 0) return `${head}\n${notes.join("\n")}`;
  return `${head}\n\n${body.join("\n")}\n\n${notes.join("\n")}`;
}

async function toolWrite(
  ctx: ToolCtx,
  args: { path: string; content?: string; base_etag?: string; author?: string; reason?: string },
): Promise<ToolOut> {
  const env = ctx.env;
  const path = normalizePath(args.path, { forWrite: true });
  if (typeof args.content !== "string") throw new Error("content 必须是字符串(本工具只写文本;原件走 PUT /raw)");
  if (!isTextPath(path))
    throw new Error(`${path} 看起来是二进制/原件路径。原件不经模型写入,请用 anc CLI 或 PUT /raw 上传`);
  const size = new TextEncoder().encode(args.content).byteLength;
  if (size > MAX_WRITE_BYTES)
    throw new Error(`超过单文本上限 ${MAX_WRITE_BYTES} B(当前 ${size} B)。请拆分成多个文件——` +
      `单个大文本文件会让它所在范围的搜索被跳过`);

  const meta = { author: args.author ?? "unknown", reason: args.reason ?? "" };
  const prev = await env.VAULT.get(path);

  if (!prev) {
    if (args.base_etag) throw new Error(`传了 base_etag 但 ${path} 不存在(可能路径写错,或文件已被删除)`);
    // 新建:onlyIf etagDoesNotMatch "*" = 仅当不存在时写入,防两个并发新建互相无痕覆盖
    const res = await env.VAULT.put(path, args.content, {
      customMetadata: meta,
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (!res) throw new Error("并发写冲突:该文件刚被他人创建。请先 vault_read 看看别人写了什么,再决定怎么合并");
    // 回带新 etag:客户端(anc CLI)据此更新本地清单,否则下次 pull 会把这个文件当「远端新增」盲目覆盖
    return { text: `已写入 ${path}(${size} B,新建)`, extra: `[vault-meta] path=${path} etag=${res.etag} size=${size}` };
  }

  // 覆盖:v1 用「刚读到的 etag」做 CAS,窗口只有毫秒 —— 上午读、下午写会静默覆盖他人改动,
  // 双方都收不到任何提示。v2 改成强制 read-before-write:客户端必须回传它读到的 etag。
  if (!args.base_etag)
    throw new Error(
      `${path} 已存在。覆盖前必须先 vault_read 拿到 etag 并作为 base_etag 传入 —— ` +
        `否则你可能正在抹掉别人刚做的改动(旧版会进 _history 但双方都不会被提示)`,
    );
  if (args.base_etag !== prev.etag)
    throw new Error(
      `版本已过期:你读到的是 ${args.base_etag},当前是 ${prev.etag} —— ` +
        `在你读完之后有人改过这个文件。请重新 vault_read,把你的改动合并进最新内容后再写。` +
        `(想看对方改了什么:vault_history("${path}"))`,
    );

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 6); // 同毫秒双写防存档 key 相撞
  const histKey = `${HISTORY_PREFIX}${path}/${ts}-${rand}`;
  await env.VAULT.put(histKey, await prev.arrayBuffer(), {
    customMetadata: { ...meta, replacedAt: ts },
  });
  let res;
  try {
    res = await env.VAULT.put(path, args.content, {
      customMetadata: meta,
      onlyIf: { etagMatches: args.base_etag },
    });
  } catch (e) {
    await env.VAULT.delete(histKey).catch(() => {}); // 写失败不留伪历史
    throw e;
  }
  if (!res) {
    await env.VAULT.delete(histKey);
    throw new Error("并发写冲突:就在刚才这一瞬间有人写入了该文件。请重新 vault_read 后合并重写");
  }
  return {
    text: `已写入 ${path}(${size} B,旧版已存档 ${histKey})`,
    extra: `[vault-meta] path=${path} etag=${res.etag} size=${size}`,
  };
}

async function toolHistory(ctx: ToolCtx, args: { path: string }): Promise<string> {
  const env = ctx.env;
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

async function toolOriginal(ctx: ToolCtx, args: { path: string }): Promise<string> {
  const path = normalizePath(args.path);
  const head = await ctx.env.VAULT.head(path);
  if (!head) return `未找到原件:${path}(用 vault_list 确认路径)`;

  const mb = (head.size / 1024 / 1024).toFixed(2);
  const name = path.split("/").pop() ?? "download";
  const url = `${ctx.origin}/raw/${path.split("/").map(encodeURIComponent).join("/")}`;

  // 找同项目 _ocr/ 下的对应文本:projects/X/_originals/A/b.pdf → projects/X/_ocr/A/b*.md
  let ocrHint = "";
  const segs = path.split("/");
  const oi = segs.indexOf(ORIGINALS_DIR);
  if (oi > 0) {
    const ocrPrefix = [...segs.slice(0, oi), "_ocr", ...segs.slice(oi + 1, segs.length - 1)].join("/") + "/";
    const page = await ctx.env.VAULT.list({ prefix: ocrPrefix, limit: 50 });
    const stem = name.replace(/\.[^.]+$/, "");
    const match = page.objects.filter((o) => o.key.includes(stem));
    ocrHint = match.length
      ? `\n✅ 本原件已有 OCR 文本,**先读它更快**(不用下载):\n` +
        match.map((o) => `   vault_read("${o.key}")`).join("\n")
      : `\n⚠️ 本原件尚无 OCR 文本。若它是无文字层扫描件,grep 搜不到其中内容属正常——需要先跑 OCR。`;
  }

  return (
    `原件 ${path}\n` +
    `大小 ${head.size} B(${mb} MB)  上传 ${head.uploaded.toISOString()}\n` +
    ocrHint +
    `\n\n下载(在**本地终端**执行,不要试图把它读进对话):\n` +
    `  curl -fsSL -H "Authorization: Bearer $ANC_TOKEN" \\\n    "${url}" -o "${name}"\n` +
    `\n装了 anc CLI 的话更简单:  anc open "${path}"\n` +
    `下载后用本地工具解析(pdftotext / Read 等)。原件永不改动,只读。`
  );
}

// ---------- HTTP 面:manifest(增量同步的依据) ----------

interface ManifestEntry {
  path: string;
  etag: string;
  size: number;
  uploaded: string;
}

/**
 * 只列 index 层(结构化 md + OCR 文本),不读任何内容 —— 这是 `anc pull` 做增量 diff 的依据。
 *
 * 性能说明(诚实标注,不假装解决了):R2 无法按扩展名过滤,必须全量 list 后在 Worker 侧筛。
 * 每次 list 取 1000 个键。真实样本 1258 个键 → 2 次 list,毫秒级。若全所 68 个项目铺开到
 * 7.5 万个键 → 75 次 list,约数秒;届时应把 manifest 物化成 R2 对象并在写入时增量更新。
 * MANIFEST_MAX_LIST_CALLS 是防跑飞的闸,触顶会在响应里显式标 truncated。
 */
async function buildManifest(env: Env, prefix: string) {
  const entries: ManifestEntry[] = [];
  let cursor: string | undefined;
  let calls = 0;
  let scannedKeys = 0;
  let truncated = false;
  do {
    const page = await env.VAULT.list({ prefix, cursor, limit: 1000 });
    calls++;
    scannedKeys += page.objects.length;
    for (const o of page.objects) {
      if (layerOf(o.key) !== "index") continue;
      entries.push({ path: o.key, etag: o.etag, size: o.size, uploaded: o.uploaded.toISOString() });
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor && calls >= MANIFEST_MAX_LIST_CALLS) {
      truncated = true;
      cursor = undefined;
    }
  } while (cursor);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, truncated, listCalls: calls, scannedKeys };
}

async function manifestEtag(entries: ManifestEntry[]): Promise<string> {
  const s = entries.map((e) => `${e.path} ${e.etag}`).join("\n");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return `"${[...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)}"`;
}

async function handleManifest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const rawPrefix = url.searchParams.get("prefix") ?? "";
  const prefix = rawPrefix ? normalizePath(rawPrefix) + "/" : "";
  const m = await buildManifest(env, prefix);
  const etag = await manifestEtag(m.entries);

  // 整个 manifest 没变 → 304,客户端连解析都省了(`anc pull` 无改动时是一次空往返)
  if (req.headers.get("if-none-match") === etag)
    return new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } });

  const totalBytes = m.entries.reduce((n, e) => n + e.size, 0);
  const payload = {
    version: 1,
    prefix,
    generated: new Date().toISOString(),
    layer: "index",
    count: m.entries.length,
    totalBytes,
    truncated: m.truncated,
    stats: { listCalls: m.listCalls, scannedKeys: m.scannedKeys },
    entries: m.entries,
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", etag, "cache-control": "no-cache" },
  });
}

// ---------- HTTP 面:/raw 流式读写(GB 级原件的唯一通道) ----------

async function handleRawGet(req: Request, env: Env, key: string): Promise<Response> {
  // 关键:把 R2 的 ReadableStream 直接当响应体,Worker 内存占用恒定(128MB 限制与文件大小无关)。
  // Cloudflare 对响应体没有强制大小限制,且等待 I/O 不计入 CPU 时间 —— GB 级透传完全成立。
  const obj = await env.VAULT.get(key, { range: req.headers, onlyIf: req.headers });
  if (!obj) return new Response("not found\n", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "no-cache");

  // onlyIf 条件不满足时 R2 返回的是不带 body 的 R2Object
  if (!("body" in obj)) {
    const method = req.headers.get("if-none-match") ? 304 : 412;
    return new Response(null, { status: method, headers });
  }

  let status = 200;
  const r = obj.range as { offset?: number; length?: number } | undefined;
  if (r && (r.offset !== undefined || r.length !== undefined)) {
    const start = r.offset ?? 0;
    const len = r.length ?? obj.size - start;
    headers.set("content-range", `bytes ${start}-${start + len - 1}/${obj.size}`);
    status = 206;
  } else {
    headers.set("content-length", String(obj.size));
  }
  return new Response(obj.body, { status, headers });
}

/** 解 percent-encoded 的 header 值;非法编码时原样返回,不让一个坏 header 打挂整次上传 */
function decodeHeader(v: string | null): string {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

async function handleRawPut(req: Request, env: Env, key: string): Promise<Response> {
  if (layerOf(key) === "history")
    return new Response("_history/ 是只读存档区\n", { status: 403 });

  // 铁律:原件永不改动、永不删除、永不重命名 —— 索引号与纸质档页码一一对应,改了就断了对应关系。
  // 所以 /raw PUT 默认只允许**新建**;要改文本请走 MCP vault_write(有历史与 CAS)。
  const ifMatch = req.headers.get("if-match");
  const onlyIf: R2Conditional = ifMatch ? { etagMatches: ifMatch } : { etagDoesNotMatch: "*" };

  // HTTP header 值只能是 ByteString(≤255),中文作者名/原因直接塞会在客户端就抛异常。
  // 约定:这两个 header 用 percent-encoding 传输。中文 vault 里这是必踩的坑,不是可选优化。
  const author = decodeHeader(req.headers.get("x-anc-author")) || "unknown";
  const reason = decodeHeader(req.headers.get("x-anc-reason"));

  const obj = await env.VAULT.put(key, req.body, {
    onlyIf,
    httpMetadata: req.headers,
    customMetadata: { author, reason },
  });
  if (!obj) {
    const exists = await env.VAULT.head(key);
    return new Response(
      exists
        ? `已存在,拒绝覆盖:${key}\n原件只读。要改文本请用 MCP vault_write;确需覆盖请带 If-Match: <etag>。\n`
        : `写入冲突:${key}\n`,
      { status: 412 },
    );
  }
  return new Response(JSON.stringify({ ok: true, path: key, etag: obj.etag, size: obj.size }) + "\n", {
    status: 201,
    headers: { "content-type": "application/json" },
  });
}

// ---------- MCP JSON-RPC(无状态 streamable HTTP)----------

type RpcMessage = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any };

function rpcResult(id: number | string | null | undefined, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}
function rpcError(id: number | string | null | undefined, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleRpc(msg: RpcMessage, ctx: ToolCtx): Promise<object | null> {
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
        const impl: Record<string, (c: ToolCtx, a: any) => Promise<ToolOut>> = {
          vault_list: toolList,
          vault_read: toolRead,
          vault_search: toolSearch,
          vault_write: toolWrite,
          vault_history: toolHistory,
          vault_original: toolOriginal,
        };
        if (!impl[name]) return rpcError(id, -32602, `未知工具:${name}`);
        try {
          const out = await impl[name](ctx, args);
          const content =
            typeof out === "string"
              ? [{ type: "text", text: out }]
              : [
                  { type: "text", text: out.text },
                  { type: "text", text: out.extra },
                ];
          return rpcResult(id, { content, isError: false });
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

const MAX_RPC_BYTES = 4 * 1024 * 1024; // MCP body 上限(只走文本,原件走 /raw)

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;

    if (url.pathname === "/" && req.method === "GET")
      return new Response(
        `anc-vault ${SERVER_INFO.version}\n` +
          `  POST /mcp          MCP 控制面(list/read/search/write/history/original)\n` +
          `  GET  /manifest     index 层清单(增量同步用)\n` +
          `  GET  /raw/<path>   流式读取(支持 Range)\n` +
          `  PUT  /raw/<path>   流式写入(原件只允许新建)\n`,
        { status: 200 },
      );

    const isRaw = url.pathname.startsWith("/raw/");
    const isManifest = url.pathname === "/manifest";
    const isMcp = url.pathname === "/mcp";
    if (!isRaw && !isManifest && !isMcp) return new Response("not found\n", { status: 404 });

    if (!authorized(req, env)) {
      if (isMcp)
        return new Response(JSON.stringify(rpcError(null, -32000, "unauthorized")), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response("unauthorized\n", { status: 401 });
    }

    // ---- /manifest ----
    if (isManifest) {
      if (req.method !== "GET") return new Response("method not allowed\n", { status: 405 });
      try {
        return await handleManifest(req, env);
      } catch (e: any) {
        return new Response(`manifest 失败:${e?.message ?? e}\n`, { status: 400 });
      }
    }

    // ---- /raw/<path> ----
    if (isRaw) {
      let key: string;
      try {
        key = normalizePath(decodeURIComponent(url.pathname.slice("/raw/".length)));
      } catch (e: any) {
        return new Response(`路径非法:${e?.message ?? e}\n`, { status: 400 });
      }
      if (req.method === "GET" || req.method === "HEAD") return await handleRawGet(req, env, key);
      if (req.method === "PUT") {
        if (!req.body) return new Response("PUT 需要请求体\n", { status: 400 });
        return await handleRawPut(req, env, key);
      }
      return new Response("method not allowed\n", { status: 405, headers: { allow: "GET, HEAD, PUT" } });
    }

    // ---- /mcp ----
    if (req.method === "GET") return new Response("stateless server: no event stream", { status: 405 });
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_RPC_BYTES)
      return new Response(JSON.stringify(rpcError(null, -32600, "request too large(原件请走 PUT /raw)")), {
        status: 413,
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
    if (Array.isArray(parsed))
      return new Response(
        JSON.stringify(rpcError(null, -32600, "batch not supported (MCP 2025-06-18: one message per POST)")),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    const response = await handleRpc(parsed as RpcMessage, { env, origin });
    if (response === null) return new Response(null, { status: 202 }); // notification
    return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
  },
};
