/**
 * schema.ts —— org 真相源类型 + 逐字段校验规则(M1-DESIGN §3.2-§3.4)。
 *
 * 纯函数:输入 frontmatter 解析结果,输出结构化对象 + 问题清单(带文件与行号)。
 * I/O(扫目录、读文件)在 load.ts。
 */

import { FmMap, FmMapValue, FmResult, FmValue } from "./frontmatter";

export type PermissionMode = "default" | "acceptEdits" | "dontAsk" | "bypassPermissions";
export const PERMISSION_MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "dontAsk",
  "bypassPermissions",
];

export const DEVBOT_ROLE = "devbot";

/** ASCII id:launchd label / project 名 / env var 名的安全字符集 */
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const PROVIDER_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
/** vault_scope 只允许一段目录名,禁止路径穿越 */
const DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface SchemaIssue {
  file: string;
  line?: number;
  message: string;
}

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface CompanyDefaults {
  model: string;
  mode: PermissionMode;
  /**
   * 可选;缺省 = 不渲染 [projects.auto_compress] 段。
   *
   * **口径警告**:这不是 Claude Code 的真实上下文占用,而是 cc-connect 自己维护的会话历史
   * 估算 —— `len([]rune(content))/4`,且 History 只含 IM 里的 user 消息与 assistant 最终回复
   * (core/engine.go:3353/4163),**不含工具输出、文件内容、系统提示**;session 空闲重置时还会
   * 清空。所以取值要按「纯对话文本字符数 ÷ 4」估,不能套 Claude 的 200k 上下文window。
   * 上游默认 12000(约 4.8 万字符对话);填 12 万级别等于该特性永不触发。
   */
  auto_compress_max_tokens?: number;
}

export interface FallbackProvider {
  name: string;
  base_url: string;
  model: string;
  // api_key 不在 org 内:走 secrets.env 的 ${ANC_PROVIDER_KEY_<NAME>}
}

export interface Company {
  name: string;
  id: string;
  language: string;
  timezone: string;
  platform: "feishu";
  defaults: CompanyDefaults;
  admins: string[];
  sync_interval_min: number;
  /** 可选;缺省 = 不渲染 providers 段 */
  fallback_provider?: FallbackProvider;
  /** company.md 正文:一句话业务简介 + 术语表(渲染进 persona 段 1) */
  brief: string;
  briefStartLine: number;
  file: string;
}

export interface PersonaSection {
  /** 归一化段名(去除全部空白,如「收资料SOP」) */
  name: string;
  content: string;
  /** H2 标题行在文件中的行号(1-based) */
  line: number;
  /** 段首行是 <!-- anc:replace --> ⇒ 替换而非追加 */
  replace: boolean;
}

export interface ParsedBody {
  /** 第一个 H2 之前的正文(member 层 = 「服务对象」块;role/base 层必须为空) */
  preamble: string;
  preambleLine: number;
  sections: PersonaSection[];
}

export interface Role {
  role: string;
  title: string;
  model: string;
  mode: PermissionMode;
  allowed_tools: string[];
  vault_scope: string[];
  skills: string[];
  body: ParsedBody;
  rawBody: string;
  bodyStartLine: number;
  file: string;
}

export interface FeishuBinding {
  app_id: string;
  open_id: string;
  /** 本人之外的额外可对话者(存量部署迁移时枚举现役用户用) */
  extra_allow_from: string[];
  allow_chat: string[];
}

export interface Member {
  name: string;
  display_name: string;
  role: string;
  feishu: FeishuBinding;
  model: string;
  admin: boolean;
  /** true = 渲染时跳过该 project(离职停用而不删档) */
  disabled: boolean;
  body: ParsedBody;
  rawBody: string;
  bodyStartLine: number;
  file: string;
}

export interface Org {
  company: Company;
  roles: Record<string, Role>;
  /** 已按 目录名排序 + devbot 殿后(输出确定性) */
  members: Member[];
}

// ---------------------------------------------------------------------------
// persona body 段解析与段落归属(M1-DESIGN §4.2 硬约定 1)
// ---------------------------------------------------------------------------

export const REPLACE_MARK = "<!-- anc:replace -->";
/** 只允许存在于 base 层的段(「每 bot 必带、逐字统一」的一等公民) */
export const BASE_ONLY_SECTIONS: readonly string[] = [
  "身份",
  "数据来源",
  "诚实条款",
  "收资料SOP",
  "动态事实",
  "服务对象",
];
/** role/member 层允许的叠加段 */
export const OVERLAY_SECTIONS: readonly string[] = ["职责", "风格", "术语表"];

export function normalizeSectionName(heading: string): string {
  return heading.replace(/\s+/g, "");
}

/** 把 markdown body 按 H2 切段;startLine = body 第一行在文件中的行号。 */
export function parsePersonaBody(body: string, startLine: number): ParsedBody {
  const lines = body.split("\n");
  const sections: PersonaSection[] = [];
  const preambleLines: string[] = [];
  let current: { name: string; line: number; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    let content = current.lines.join("\n").trim();
    let replace = false;
    const first = content.split("\n")[0] ?? "";
    if (first.trim() === REPLACE_MARK) {
      replace = true;
      content = content.split("\n").slice(1).join("\n").trim();
    }
    sections.push({ name: current.name, content, line: current.line, replace });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const h2 = /^##\s+(.+?)\s*$/.exec(line);
    if (h2 && !line.startsWith("###")) {
      flush();
      current = { name: normalizeSectionName(h2[1] as string), line: startLine + i, lines: [] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  flush();
  return {
    preamble: preambleLines.join("\n").trim(),
    preambleLine: startLine,
    sections,
  };
}

/** role/member body 的段落归属校验。 */
export function checkBodySections(parsed: ParsedBody, kind: "role" | "member", file: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (kind === "role" && parsed.preamble !== "") {
    issues.push({
      file,
      line: parsed.preambleLine,
      message: "role body 不允许 H2 段之外的正文(只允许 ## 职责 / ## 风格 / ## 术语表)",
    });
  }
  const seen = new Set<string>();
  for (const s of parsed.sections) {
    if (seen.has(s.name)) {
      issues.push({ file, line: s.line, message: `重复的段 \`## ${s.name}\`` });
    }
    seen.add(s.name);
    if (BASE_ONLY_SECTIONS.includes(s.name)) {
      issues.push({
        file,
        line: s.line,
        message: `段落归属:\`## ${s.name}\` 只允许存在于 base 层(persona-base.md),role/member 层不得私藏或覆盖公共纪律段`,
      });
    } else if (!OVERLAY_SECTIONS.includes(s.name)) {
      issues.push({
        file,
        line: s.line,
        message: `未知 H2 段 \`## ${s.name}\`(允许:${OVERLAY_SECTIONS.map((n) => `## ${n}`).join(" / ")})`,
      });
    }
  }
  if (kind === "role") {
    for (const required of ["职责", "风格"]) {
      if (!parsed.sections.some((s) => s.name === required)) {
        issues.push({ file, message: `role body 缺少必需段 \`## ${required}\`` });
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 字段读取器
// ---------------------------------------------------------------------------

class FieldReader {
  readonly issues: SchemaIssue[] = [];
  private readonly used = new Set<string>();

  constructor(
    private readonly fm: FmResult,
    private readonly file: string,
  ) {}

  err(key: string | undefined, message: string): void {
    const issue: SchemaIssue = { file: this.file, message };
    if (key !== undefined && this.fm.keyLines[key] !== undefined) issue.line = this.fm.keyLines[key];
    this.issues.push(issue);
  }

  private get(key: string): FmValue | undefined {
    this.used.add(key);
    return this.fm.data[key];
  }

  requireString(key: string, opts?: { pattern?: RegExp; patternMsg?: string; allowEmpty?: boolean }): string {
    const v = this.get(key);
    if (v === undefined) {
      this.err(undefined, `缺少必填字段 \`${key}\``);
      return "";
    }
    if (typeof v !== "string") {
      this.err(key, `字段 \`${key}\` 须为字符串`);
      return "";
    }
    if (!opts?.allowEmpty && v.trim() === "") {
      this.err(key, `字段 \`${key}\` 不能为空`);
      return "";
    }
    if (opts?.pattern && v !== "" && !opts.pattern.test(v)) {
      this.err(key, `字段 \`${key}\` 格式不合法${opts.patternMsg ? `:${opts.patternMsg}` : ""}(实际值:${JSON.stringify(v)})`);
    }
    return v;
  }

  optionalString(key: string, dflt: string): string {
    const v = this.get(key);
    if (v === undefined) return dflt;
    if (typeof v !== "string") {
      this.err(key, `字段 \`${key}\` 须为字符串`);
      return dflt;
    }
    return v;
  }

  optionalBoolean(key: string, dflt: boolean): boolean {
    const v = this.get(key);
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") {
      this.err(key, `字段 \`${key}\` 须为 true/false`);
      return dflt;
    }
    return v;
  }

  requireInt(key: string, opts: { min: number }): number {
    const v = this.get(key);
    if (v === undefined) {
      this.err(undefined, `缺少必填字段 \`${key}\``);
      return opts.min;
    }
    if (typeof v !== "number" || !Number.isInteger(v)) {
      this.err(key, `字段 \`${key}\` 须为整数`);
      return opts.min;
    }
    if (v < opts.min) {
      this.err(key, `字段 \`${key}\` 须 ≥ ${opts.min}`);
      return opts.min;
    }
    return v;
  }

  requireStringArray(key: string, opts?: { itemPattern?: RegExp; itemMsg?: string; allowEmpty?: boolean }): string[] {
    const v = this.get(key);
    if (v === undefined) {
      this.err(undefined, `缺少必填字段 \`${key}\``);
      return [];
    }
    return this.coerceStringArray(key, v, opts);
  }

  optionalStringArray(key: string, opts?: { itemPattern?: RegExp; itemMsg?: string }): string[] {
    const v = this.get(key);
    if (v === undefined) return [];
    return this.coerceStringArray(key, v, { ...opts, allowEmpty: true });
  }

  private coerceStringArray(
    key: string,
    v: FmValue,
    opts?: { itemPattern?: RegExp; itemMsg?: string; allowEmpty?: boolean },
  ): string[] {
    if (!Array.isArray(v)) {
      this.err(key, `字段 \`${key}\` 须为字符串数组([a, b])`);
      return [];
    }
    if (!opts?.allowEmpty && v.length === 0) {
      this.err(key, `字段 \`${key}\` 不能为空数组`);
    }
    for (const item of v) {
      if (item.trim() === "") {
        this.err(key, `字段 \`${key}\` 含空元素`);
      } else if (opts?.itemPattern && !opts.itemPattern.test(item)) {
        this.err(key, `字段 \`${key}\` 元素格式不合法${opts.itemMsg ? `:${opts.itemMsg}` : ""}(实际值:${JSON.stringify(item)})`);
      }
    }
    return v;
  }

  requireMap(key: string): FmMap | undefined {
    const v = this.get(key);
    if (v === undefined) {
      this.err(undefined, `缺少必填字段 \`${key}\``);
      return undefined;
    }
    if (typeof v !== "object" || Array.isArray(v)) {
      this.err(key, `字段 \`${key}\` 须为一层嵌套映射`);
      return undefined;
    }
    return v;
  }

  optionalMap(key: string): FmMap | undefined {
    const v = this.get(key);
    if (v === undefined) return undefined;
    if (typeof v !== "object" || Array.isArray(v)) {
      this.err(key, `字段 \`${key}\` 须为一层嵌套映射`);
      return undefined;
    }
    return v;
  }

  mode(key: string): PermissionMode {
    const v = this.requireString(key);
    if (v !== "" && !(PERMISSION_MODES as readonly string[]).includes(v)) {
      this.err(key, `字段 \`${key}\` 须为 ${PERMISSION_MODES.join(" / ")} 之一(实际值:${JSON.stringify(v)})`);
      return "default";
    }
    return (v || "default") as PermissionMode;
  }

  /** 声明式白名单:出现未知顶层键即报错(防拼写错误被静默忽略)。 */
  rejectUnknownKeys(): void {
    for (const key of Object.keys(this.fm.data)) {
      if (!this.used.has(key)) {
        this.err(key, `未知字段 \`${key}\``);
      }
    }
  }
}

/** 嵌套映射的子字段读取(错误行号取 `parent.sub`)。 */
class MapReader {
  private readonly used = new Set<string>();

  constructor(
    private readonly map: FmMap,
    private readonly parent: string,
    private readonly reader: FieldReader,
  ) {}

  private get(sub: string): FmMapValue | undefined {
    this.used.add(sub);
    return this.map[sub];
  }

  requireString(sub: string, opts?: { pattern?: RegExp; patternMsg?: string; allowEmpty?: boolean }): string {
    const key = `${this.parent}.${sub}`;
    const v = this.get(sub);
    if (v === undefined) {
      this.reader.err(this.parent, `缺少必填字段 \`${key}\``);
      return "";
    }
    if (typeof v !== "string") {
      this.reader.err(key, `字段 \`${key}\` 须为字符串`);
      return "";
    }
    if (!opts?.allowEmpty && v.trim() === "") {
      this.reader.err(key, `字段 \`${key}\` 不能为空`);
      return "";
    }
    if (opts?.pattern && v !== "" && !opts.pattern.test(v)) {
      this.reader.err(
        key,
        `字段 \`${key}\` 格式不合法${opts.patternMsg ? `:${opts.patternMsg}` : ""}(实际值:${JSON.stringify(v)})`,
      );
    }
    return v;
  }

  optionalString(sub: string, dflt: string): string {
    const key = `${this.parent}.${sub}`;
    const v = this.get(sub);
    if (v === undefined) return dflt;
    if (typeof v !== "string") {
      this.reader.err(key, `字段 \`${key}\` 须为字符串`);
      return dflt;
    }
    return v;
  }

  optionalInt(sub: string, opts: { min: number }): number | undefined {
    const key = `${this.parent}.${sub}`;
    const v = this.get(sub);
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v)) {
      this.reader.err(key, `字段 \`${key}\` 须为整数`);
      return undefined;
    }
    if (v < opts.min) {
      this.reader.err(key, `字段 \`${key}\` 须 ≥ ${opts.min}`);
      return undefined;
    }
    return v;
  }

  optionalStringArray(sub: string, opts?: { itemPattern?: RegExp; itemMsg?: string; banWildcard?: boolean }): string[] {
    const key = `${this.parent}.${sub}`;
    const v = this.get(sub);
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.reader.err(key, `字段 \`${key}\` 须为字符串数组([a, b])`);
      return [];
    }
    for (const item of v) {
      if (item.trim() === "") {
        this.reader.err(key, `字段 \`${key}\` 含空元素`);
      } else if (opts?.banWildcard && item === "*") {
        this.reader.err(key, `字段 \`${key}\` 不允许通配符 "*"(SPEC §7:白名单默认关闭注册)`);
      } else if (opts?.itemPattern && !opts.itemPattern.test(item)) {
        this.reader.err(key, `字段 \`${key}\` 元素格式不合法${opts.itemMsg ? `:${opts.itemMsg}` : ""}(实际值:${JSON.stringify(item)})`);
      }
    }
    return v;
  }

  mode(sub: string): PermissionMode {
    const key = `${this.parent}.${sub}`;
    const v = this.requireString(sub);
    if (v !== "" && !(PERMISSION_MODES as readonly string[]).includes(v)) {
      this.reader.err(key, `字段 \`${key}\` 须为 ${PERMISSION_MODES.join(" / ")} 之一(实际值:${JSON.stringify(v)})`);
      return "default";
    }
    return (v || "default") as PermissionMode;
  }

  rejectUnknownKeys(): void {
    for (const sub of Object.keys(this.map)) {
      if (!this.used.has(sub)) {
        this.reader.err(`${this.parent}.${sub}`, `未知字段 \`${this.parent}.${sub}\``);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// company / role / member 构建
// ---------------------------------------------------------------------------

export interface BuildResult<T> {
  value?: T;
  issues: SchemaIssue[];
}

export function buildCompany(fm: FmResult, file: string): BuildResult<Company> {
  const r = new FieldReader(fm, file);
  for (const e of fm.errors) r.issues.push({ file, line: e.line, message: e.message });

  const name = r.requireString("name");
  const id = r.requireString("id", {
    pattern: ID_RE,
    patternMsg: "须为小写 ASCII(^[a-z][a-z0-9-]{0,31}$),用作 launchd label 与 project 名前缀",
  });
  const language = r.requireString("language");
  const timezone = r.requireString("timezone");
  const platform = r.requireString("platform");
  if (platform !== "" && platform !== "feishu") {
    r.err("platform", `字段 \`platform\` v1 唯一取值为 "feishu"(实际值:${JSON.stringify(platform)})`);
  }

  let defaults: CompanyDefaults = { model: "", mode: "default" };
  const defaultsMap = r.requireMap("defaults");
  if (defaultsMap) {
    const d = new MapReader(defaultsMap, "defaults", r);
    const model = d.requireString("model");
    const mode = d.mode("mode");
    if (mode === "bypassPermissions") {
      r.err("defaults.mode", "字段 `defaults.mode` 不允许 bypassPermissions(角色 bot 一律不授予 bypass,SPEC §7)");
    }
    const act = d.optionalInt("auto_compress_max_tokens", { min: 1 });
    d.rejectUnknownKeys();
    defaults = { model, mode };
    if (act !== undefined) defaults.auto_compress_max_tokens = act;
  }

  const admins = r.requireStringArray("admins", {
    itemPattern: ID_RE,
    itemMsg: "须为 member id(小写 ASCII)",
  });
  const sync_interval_min = r.requireInt("sync_interval_min", { min: 1 });

  let fallback_provider: FallbackProvider | undefined;
  const fpMap = r.optionalMap("fallback_provider");
  if (fpMap) {
    const f = new MapReader(fpMap, "fallback_provider", r);
    const fpName = f.optionalString("name", "");
    const fpBase = f.optionalString("base_url", "");
    const fpModel = f.optionalString("model", "");
    f.rejectUnknownKeys();
    if (fpName === "" && fpBase === "" && fpModel === "") {
      fallback_provider = undefined; // 全空 = 缺省(模板占位形态)
    } else if (fpName === "") {
      r.err("fallback_provider", "字段 `fallback_provider.name` 为空但 base_url/model 非空 —— 要么全空(缺省),要么补全 name");
    } else {
      if (!PROVIDER_NAME_RE.test(fpName)) {
        r.err("fallback_provider.name", `字段 \`fallback_provider.name\` 格式不合法(用于生成 env var 名,须匹配 ${PROVIDER_NAME_RE})`);
      }
      if (fpBase.trim() === "") r.err("fallback_provider", "字段 `fallback_provider.base_url` 不能为空");
      if (fpModel.trim() === "") r.err("fallback_provider", "字段 `fallback_provider.model` 不能为空");
      fallback_provider = { name: fpName, base_url: fpBase, model: fpModel };
    }
  }

  r.rejectUnknownKeys();

  const brief = fm.body.trim();
  if (brief === "") {
    r.issues.push({
      file,
      line: fm.bodyStartLine,
      message: "company.md 正文(业务简介 + 术语表)不能为空 —— 它渲染进每个 persona 的段 1 与根 CLAUDE.md Quick Facts",
    });
  }

  const value: Company = {
    name,
    id,
    language,
    timezone,
    platform: "feishu",
    defaults,
    admins,
    sync_interval_min,
    brief,
    briefStartLine: fm.bodyStartLine,
    file,
  };
  if (fallback_provider) value.fallback_provider = fallback_provider;
  return { value: r.issues.length === 0 ? value : undefined, issues: r.issues };
}

export function buildRole(fm: FmResult, file: string, dirName: string): BuildResult<Role> {
  const r = new FieldReader(fm, file);
  for (const e of fm.errors) r.issues.push({ file, line: e.line, message: e.message });

  const role = r.requireString("role", { pattern: ID_RE, patternMsg: "须为小写 ASCII" });
  if (role !== "" && role !== dirName) {
    r.err("role", `字段 \`role\` (${JSON.stringify(role)}) 须与目录名 (${JSON.stringify(dirName)}) 一致`);
  }
  const title = r.requireString("title");
  const model = r.optionalString("model", "");
  const mode = r.mode("mode");
  const allowed_tools = r.requireStringArray("allowed_tools", { allowEmpty: true });
  const vault_scope = r.optionalStringArray("vault_scope", {
    itemPattern: DIR_NAME_RE,
    itemMsg: "须为 vault 顶层目录名(单段,无路径分隔符)",
  });
  const skills = r.optionalStringArray("skills");
  r.rejectUnknownKeys();

  // devbot 特判(M1-DESIGN §3.3):mode 必须 bypassPermissions、allowed_tools 必须为空(全开);
  // 非 devbot:一律禁 bypass、allowed_tools 必须非空(SPEC §7 红线,无豁免开关)。
  if (role === DEVBOT_ROLE) {
    if (mode !== "bypassPermissions") {
      r.err("mode", "devbot 角色的 `mode` 须为 bypassPermissions(cwd = vault 本体,git 可回滚;M1-DESIGN §3.3)");
    }
    if (allowed_tools.length !== 0) {
      r.err("allowed_tools", "devbot 角色的 `allowed_tools` 须为 [](全开)");
    }
  } else {
    if (mode === "bypassPermissions") {
      r.err("mode", `角色 \`${role}\` 不允许 bypassPermissions —— 角色 bot 一律不授予 bypass,仅 devbot 例外(SPEC §7 红线,无豁免开关)`);
    }
    if (allowed_tools.length === 0) {
      r.err("allowed_tools", `角色 \`${role}\` 的 \`allowed_tools\` 不能为空 —— 空数组语义为「全开」,仅 devbot 允许`);
    }
  }

  const body = parsePersonaBody(fm.body, fm.bodyStartLine);
  for (const issue of checkBodySections(body, "role", file)) r.issues.push(issue);

  const value: Role = {
    role,
    title,
    model,
    mode,
    allowed_tools,
    vault_scope,
    skills,
    body,
    rawBody: fm.body,
    bodyStartLine: fm.bodyStartLine,
    file,
  };
  return { value: r.issues.length === 0 ? value : undefined, issues: r.issues };
}

export function buildMember(fm: FmResult, file: string, dirName: string): BuildResult<Member> {
  const r = new FieldReader(fm, file);
  for (const e of fm.errors) r.issues.push({ file, line: e.line, message: e.message });

  const name = r.requireString("name", { pattern: ID_RE, patternMsg: "须为小写 ASCII" });
  if (name !== "" && name !== dirName) {
    r.err("name", `字段 \`name\` (${JSON.stringify(name)}) 须与目录名 (${JSON.stringify(dirName)}) 一致`);
  }
  const display_name = r.requireString("display_name");
  const role = r.requireString("role");

  let feishu: FeishuBinding = { app_id: "", open_id: "", extra_allow_from: [], allow_chat: [] };
  const fmMap = r.requireMap("feishu");
  if (fmMap) {
    const f = new MapReader(fmMap, "feishu", r);
    // 一律禁逗号与空白:allow_from/allow_chat/admin_from 在上游是**逗号分隔字符串**,
    // 含逗号的 id 会被 strings.Split 切成两半、两半都匹配不上任何人 —— 静默失效且无日志。
    // 字符集保留 `*`:ou_*** / cli_*** 是本库既定的脱敏占位符约定(CLAUDE.md)。
    const NO_SEP = "不得含逗号或空白 —— 上游按逗号切分白名单,含分隔符的 id 会被切断并静默失效";
    const app_id = f.requireString("app_id", { pattern: /^cli_[^\s,]+$/, patternMsg: `须以 cli_ 开头(飞书自建应用 App ID),${NO_SEP}` });
    const open_id = f.requireString("open_id", { pattern: /^ou_[^\s,]+$/, patternMsg: `须以 ou_ 开头(飞书用户 open_id),${NO_SEP}` });
    const extra_allow_from = f.optionalStringArray("extra_allow_from", {
      itemPattern: /^ou_[^\s,]+$/,
      itemMsg: `须以 ou_ 开头(通配符与用户名不接受),${NO_SEP}`,
      banWildcard: true,
    });
    const allow_chat = f.optionalStringArray("allow_chat", {
      itemPattern: /^oc_[^\s,]+$/,
      itemMsg: `须以 oc_ 开头(飞书群 chat_id),${NO_SEP}`,
      banWildcard: true,
    });
    f.rejectUnknownKeys();
    feishu = { app_id, open_id, extra_allow_from, allow_chat };
  }

  const model = r.optionalString("model", "");
  const admin = r.optionalBoolean("admin", false);
  const disabled = r.optionalBoolean("disabled", false);
  r.rejectUnknownKeys();

  const body = parsePersonaBody(fm.body, fm.bodyStartLine);
  for (const issue of checkBodySections(body, "member", file)) r.issues.push(issue);

  const value: Member = {
    name,
    display_name,
    role,
    feishu,
    model,
    admin,
    disabled,
    body,
    rawBody: fm.body,
    bodyStartLine: fm.bodyStartLine,
    file,
  };
  return { value: r.issues.length === 0 ? value : undefined, issues: r.issues };
}

// ---------------------------------------------------------------------------
// org 级校验(引用完整性 / 唯一性 / devbot 唯一)
// ---------------------------------------------------------------------------

export function checkOrg(company: Company, roles: Record<string, Role>, members: Member[]): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const byName = new Map<string, Member>();
  for (const m of members) {
    if (byName.has(m.name)) {
      issues.push({ file: m.file, message: `member 名 \`${m.name}\` 重复` });
    }
    byName.set(m.name, m);
  }

  for (const m of members) {
    if (!(m.role in roles)) {
      issues.push({ file: m.file, message: `member \`${m.name}\` 引用了不存在的角色 \`${m.role}\`(roles/ 下无此目录)` });
    }
  }

  // admins:必须指向存在且未停用的 member;member.admin 标记与 company.admins 必须一致(单一真相,防漂移)
  for (const a of company.admins) {
    const m = byName.get(a);
    if (!m) {
      issues.push({ file: company.file, message: `admins 引用了不存在的 member \`${a}\`` });
    } else if (m.disabled) {
      issues.push({ file: company.file, message: `admins 引用的 member \`${a}\` 已停用(disabled: true)` });
    }
  }
  for (const m of members) {
    const listed = company.admins.includes(m.name);
    if (m.admin !== listed) {
      issues.push({
        file: m.file,
        message: `member \`${m.name}\` 的 admin 标记(${m.admin})与 company.admins(${listed ? "含" : "不含"}其名)不一致 —— admin 身份的真相源是 company.admins,请改一致`,
      });
    }
  }

  // devbot 唯一性:启用成员中恰好一个 devbot
  const devbots = members.filter((m) => !m.disabled && m.role === DEVBOT_ROLE);
  if (devbots.length === 0) {
    issues.push({ file: company.file, message: "全公司须恰好一个启用的 devbot 成员(当前 0 个)—— devbot 是公司的开发运维 bot(SPEC §2)" });
  } else if (devbots.length > 1) {
    issues.push({
      file: company.file,
      message: `全公司须恰好一个启用的 devbot 成员(当前 ${devbots.length} 个:${devbots.map((m) => m.name).join(", ")})`,
    });
  }

  // app_id 在启用成员间唯一
  const appIds = new Map<string, string>();
  for (const m of members) {
    if (m.disabled) continue;
    const prev = appIds.get(m.feishu.app_id);
    if (prev !== undefined) {
      issues.push({ file: m.file, message: `app_id \`${m.feishu.app_id}\` 与启用成员 \`${prev}\` 重复 —— 每 bot 一个飞书自建应用` });
    } else {
      appIds.set(m.feishu.app_id, m.name);
    }
  }

  return issues;
}
