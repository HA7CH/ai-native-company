/**
 * validate.ts —— 三重校验(M1-DESIGN §4.4;吸收 cc-allow.sh 规则)。
 *
 *   1. 结构校验(round-trip):mini 解析器读回生成文本,projects 数 == 启用成员数、
 *      app_id 集合一致、每个 append_system_prompt 的 SHA256 == 渲染锚点 hash
 *      (锚点 = literalBlockValue(persona),即 gateway 真正会读到的字节,见 toml.ts);
 *   2. 语义校验:^ou_ / app_id 唯一 / admin_from 在 project 顶层 / ${ANC_*} 在 secrets
 *      中非空 / bypass 仅 devbot(SPEC §7 红线,无豁免开关)/ extra 段 secret 只许
 *      ${ENV} / devbot 之外 allowed_tools 非空 / allow_from 无 "*" / 指纹头存在;
 *   3. 差分校验:无 anc 指纹且未给 --adopt 拒绝覆盖;增删 project 须显式 --allow-scale;
 *      逐 project 给 persona/allow_from/model 变更摘要(secret 已是 env 引用,可安全打印)。
 *
 * 校验器为纯函数:secrets、现行 config 文本等 I/O 产物由调用方注入。
 */

import { DEVBOT_ROLE, Org } from "../org/schema";
import {
  enabledMembersInOrder,
  FINGERPRINT_RE,
  parseAncToml,
  ParsedConfig,
  projectName,
  RenderedConfig,
  sha256,
  TomlPrim,
} from "./toml";

export interface ValidationIssue {
  level: "ERROR" | "WARN";
  rule: string;
  message: string;
}

const err = (rule: string, message: string): ValidationIssue => ({ level: "ERROR", rule, message });
const warn = (rule: string, message: string): ValidationIssue => ({ level: "WARN", rule, message });

// ---------------------------------------------------------------------------
// 1. 结构校验(round-trip)
// ---------------------------------------------------------------------------

export function validateRoundTrip(rendered: RenderedConfig, org: Org): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const parsed = parseAncToml(rendered.text);
  for (const e of parsed.errors) {
    issues.push(err("RT-PARSE", `第 ${e.line} 行:${e.message}`));
  }
  const members = enabledMembersInOrder(org);
  if (parsed.projects.length !== members.length) {
    issues.push(
      err("RT-COUNT", `round-trip projects 数(${parsed.projects.length})≠ 启用成员数(${members.length})`),
    );
  }
  const orgAppIds = new Set(members.map((m) => m.feishu.app_id));
  const cfgAppIds = new Set<string>();
  for (const p of parsed.projects) {
    for (const platform of p.platforms) {
      const appId = platform.options["app_id"];
      if (typeof appId === "string") cfgAppIds.add(appId);
    }
  }
  const missing = [...orgAppIds].filter((id) => !cfgAppIds.has(id));
  const extra = [...cfgAppIds].filter((id) => !orgAppIds.has(id));
  if (missing.length > 0 || extra.length > 0) {
    issues.push(
      err(
        "RT-APPID",
        `round-trip app_id 集合不一致${missing.length > 0 ? `;org 有而 config 无:${missing.join(", ")}` : ""}${extra.length > 0 ? `;config 有而 org 无:${extra.join(", ")}` : ""}`,
      ),
    );
  }
  for (const p of parsed.projects) {
    const name = typeof p.top["name"] === "string" ? (p.top["name"] as string) : `(第 ${p.headerLine} 行)`;
    const personaText = p.options["append_system_prompt"];
    const expected = rendered.personaSha[name];
    if (typeof personaText !== "string") {
      issues.push(err("RT-PERSONA", `project \`${name}\` 缺 append_system_prompt`));
    } else if (expected === undefined) {
      issues.push(err("RT-PERSONA", `project \`${name}\` 不在渲染输入内(hash 锚点缺失)`));
    } else if (sha256(personaText) !== expected) {
      issues.push(err("RT-PERSONA", `project \`${name}\` 的 append_system_prompt SHA256 与渲染输入不一致(注入/转义损坏)`));
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// 2. 语义校验
// ---------------------------------------------------------------------------

/** 从 secrets.env 文本解析 KEY=VALUE(供调用方读文件后注入;支持 export 前缀与引号值)。 */
export function parseSecretsEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

/** extra 段内的 secret 类字段名(出现明文赋值即拒,裁决 12)。 */
const SECRET_KEY_RE = /(secret|password|api[-_]?key|token)/i;
const ENV_REF_VALUE_RE = /^"\$\{[A-Za-z_][A-Za-z0-9_]*\}"$/;

export interface SemanticContext {
  org: Org;
  /** secrets.env 解析结果(由调用方注入) */
  secrets: Record<string, string>;
  /** gateway-extra.toml 原文(可选) */
  gatewayExtra?: string;
}

export function validateSemantic(rendered: RenderedConfig, ctx: SemanticContext): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const parsed = parseAncToml(rendered.text);
  const { org } = ctx;

  // 指纹头
  if (!parsed.fingerprint) {
    issues.push(err("SEM-FINGERPRINT", "文件缺少 anc 指纹头(# anc:generated v=… inputs=… at=…)"));
  }

  // devbot project 名(bypass 白名单)
  const devbot = enabledMembersInOrder(org).find((m) => m.role === DEVBOT_ROLE);
  const devbotProject = devbot ? projectName(org.company.id, devbot.name) : undefined;

  const seenAppIds = new Map<string, string>();
  for (const p of parsed.projects) {
    const name = typeof p.top["name"] === "string" ? (p.top["name"] as string) : `(第 ${p.headerLine} 行)`;

    // admin_from 必须在 project 顶层(写进 platforms.options 被上游静默忽略)
    const adminFrom = p.top["admin_from"];
    if (typeof adminFrom !== "string" || adminFrom.trim() === "") {
      issues.push(err("SEM-ADMIN-TOP", `project \`${name}\` 缺 project 顶层的 admin_from`));
    } else {
      for (const id of adminFrom.split(",")) {
        if (!/^ou_/.test(id.trim())) {
          issues.push(err("SEM-OPENID", `project \`${name}\` 的 admin_from 含非 ^ou_ 值:${JSON.stringify(id.trim())}`));
        }
      }
    }

    for (const platform of p.platforms) {
      if ("admin_from" in platform.options) {
        issues.push(
          err("SEM-ADMIN-TOP", `project \`${name}\` 的 admin_from 写进了 platforms.options —— 会被上游静默忽略,必须在 project 顶层`),
        );
      }
      const appId = platform.options["app_id"];
      if (typeof appId === "string") {
        const prev = seenAppIds.get(appId);
        if (prev !== undefined) {
          issues.push(err("SEM-APPID", `app_id \`${appId}\` 在 \`${prev}\` 与 \`${name}\` 重复 —— 全局唯一`));
        } else {
          seenAppIds.set(appId, name);
        }
      }
      // allow_from / allow_chat 必须是逗号分隔字符串:上游一律 `opts["allow_from"].(string)`,
      // TOML 数组解出 []any 断言失败 → 空串 → core.AllowList 放行任意用户。形态错 = 安全边界失效,
      // 且上游只在 stdout 留一条 warn 不阻断启动 —— 这道校验是该形态的唯一防线。
      for (const listKey of ["allow_from", "allow_chat"] as const) {
        const raw = platform.options[listKey];
        if (raw === undefined) {
          if (listKey === "allow_from") {
            issues.push(err("SEM-WILDCARD", `project \`${name}\` 的 platforms.options 缺 allow_from 白名单 —— 上游对空值 fail-open(允许所有人)`));
          }
          continue; // allow_chat 可选:不写 = 上游默认放行全部群,由 group_only 等另行约束
        }
        if (Array.isArray(raw)) {
          issues.push(
            err(
              "SEM-ALLOWLIST-TYPE",
              `project \`${name}\` 的 ${listKey} 渲染成了 TOML 数组 —— 上游只认逗号分隔字符串,` +
                `数组会让类型断言失败并退化为「允许所有人」(fail-open),必须是 "a,b" 形态`,
            ),
          );
          continue;
        }
        if (typeof raw !== "string" || raw.trim() === "") {
          issues.push(err("SEM-WILDCARD", `project \`${name}\` 的 ${listKey} 为空 —— 上游对空值 fail-open(允许所有人)`));
          continue;
        }
        const prefix = listKey === "allow_from" ? "ou_" : "oc_";
        for (const rawId of raw.split(",")) {
          const id = rawId.trim();
          if (id === "*") {
            issues.push(err("SEM-WILDCARD", `project \`${name}\` 的 ${listKey} 含通配符 "*" —— 白名单默认关闭注册(SPEC §7)`));
          } else if (id === "") {
            issues.push(err("SEM-OPENID", `project \`${name}\` 的 ${listKey} 含空条目(多余逗号)—— 上游按逗号切分,空段等于噪声`));
          } else if (!id.startsWith(prefix)) {
            issues.push(err("SEM-OPENID", `project \`${name}\` 的 ${listKey} 含非 ^${prefix} 值:${JSON.stringify(id)}`));
          }
        }
      }
    }

    // bypass 仅 devbot;devbot 之外 allowed_tools 非空
    const mode = p.options["mode"];
    if (mode === "bypassPermissions" && name !== devbotProject) {
      issues.push(
        err("SEM-BYPASS", `project \`${name}\` 使用 bypassPermissions —— 角色 bot 一律不授予 bypass,仅 devbot(${devbotProject ?? "缺失"})例外(SPEC §7 红线,无豁免开关)`),
      );
    }
    if (name !== devbotProject) {
      const tools = p.options["allowed_tools"];
      if (!Array.isArray(tools) || tools.length === 0) {
        issues.push(err("SEM-TOOLS", `project \`${name}\` 缺非空 allowed_tools —— 不写该键语义为「全开」,仅 devbot 允许`));
      }
    }
  }

  // ${ANC_*} 引用必须在 secrets 中存在且非空(缺 secret 拒绝上线,治「空凭据全员同挂」于门外)
  const refRe = /\$\{(ANC_[A-Z0-9_]+)\}/g;
  const seenRefs = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = refRe.exec(rendered.text)) !== null) {
    seenRefs.add(m[1] as string);
  }
  for (const ref of [...seenRefs].sort()) {
    const v = ctx.secrets[ref];
    if (v === undefined) {
      issues.push(err("SEM-SECRET", `config 引用 \${${ref}} 但 secrets.env 未定义 —— 缺 secret 拒绝上线`));
    } else if (v.trim() === "") {
      issues.push(err("SEM-SECRET", `config 引用 \${${ref}} 但 secrets.env 中为空值 —— 空凭据会全员同挂`));
    }
  }

  // extra 段:secret 类字段只允许 ${ENV} 引用形态(明文赋值即拒,承诺无例外)
  if (ctx.gatewayExtra !== undefined) {
    const extraLines = ctx.gatewayExtra.split("\n");
    for (let i = 0; i < extraLines.length; i++) {
      const line = (extraLines[i] as string).trim();
      if (line === "" || line.startsWith("#") || line.startsWith("[")) continue;
      const kv = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.+)$/.exec(line);
      if (!kv) continue;
      const key = kv[1] as string;
      const value = (kv[2] as string).trim();
      if (SECRET_KEY_RE.test(key) && !ENV_REF_VALUE_RE.test(value)) {
        issues.push(
          err(
            "SEM-EXTRA-SECRET",
            `gateway-extra.toml 第 ${i + 1} 行:secret 类字段 \`${key}\` 必须为 "\${ENV}" 引用形态 —— config/备份/diff 全程无明文,extra 段无例外(裁决 12)`,
          ),
        );
      }
      // extra 段引用的非 ANC_ 环境变量不归 anc 管理,给 WARN 提示
      const envRef = /^"\$\{([A-Za-z_][A-Za-z0-9_]*)\}"$/.exec(value);
      if (envRef && !(envRef[1] as string).startsWith("ANC_")) {
        issues.push(
          warn("SEM-EXTRA-ENV", `gateway-extra.toml 第 ${i + 1} 行:引用非 ANC_ 前缀环境变量 \${${envRef[1]}} —— 不受 secrets.env 校验保护,需自行保证注入`),
        );
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 3. 差分校验
// ---------------------------------------------------------------------------

export interface DiffOptions {
  adopt: boolean;
  allowScale: boolean;
}

export interface DiffResult {
  issues: ValidationIssue[];
  /** 人读摘要(dry-run 默认打印) */
  summary: string[];
}

function projectByName(parsed: ParsedConfig): Map<string, ParsedConfig["projects"][number]> {
  const map = new Map<string, ParsedConfig["projects"][number]>();
  for (const p of parsed.projects) {
    if (typeof p.top["name"] === "string") map.set(p.top["name"] as string, p);
  }
  return map;
}

function fmt(v: TomlPrim | undefined): string {
  if (v === undefined) return "(无)";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}

export function validateDiff(rendered: RenderedConfig, currentText: string | null, opts: DiffOptions): DiffResult {
  const issues: ValidationIssue[] = [];
  const summary: string[] = [];

  if (currentText === null) {
    summary.push(`首次部署:无现行 config,新增 ${rendered.projectNames.length} 个 project(${rendered.projectNames.join(", ")})`);
    return { issues, summary };
  }

  const hasFingerprint = FINGERPRINT_RE.test((currentText.split("\n")[0] ?? ""));
  if (!hasFingerprint && !opts.adopt) {
    issues.push(
      err(
        "DIFF-ADOPT",
        "现行 config 无 anc 指纹(疑似手写生产配置)—— 拒绝覆盖。确认过影子渲染 diff 后用 --adopt 显式接管(M1-DESIGN §8.2)",
      ),
    );
    return { issues, summary };
  }

  const current = parseAncToml(currentText);
  const currentParseable = current.errors.length === 0;

  if (hasFingerprint && !currentParseable && !opts.adopt) {
    issues.push(
      err(
        "DIFF-ADOPT",
        `现行 config 带 anc 指纹但无法按自家产出形态解析(${current.errors.length} 处)—— 疑似手改(事故)。人工核对后用 --adopt 接管,或先 anc rollback`,
      ),
    );
    return { issues, summary };
  }

  if (!currentParseable) {
    // --adopt 接管外来/手改形态:结构 diff 不可用,只做规模闸(以 [[projects]] 计数)
    const currentCount = (currentText.match(/^\[\[projects\]\]\s*$/gm) ?? []).length;
    summary.push(`--adopt 接管:现行 config 非 anc 产出形态,结构 diff 不可用 —— 请按影子渲染流程人工比对(M1-DESIGN §8.2)`);
    if (currentCount !== rendered.projectNames.length && !opts.allowScale) {
      issues.push(
        err(
          "DIFF-SCALE",
          `project 数量变化(现行 ${currentCount} → 新 ${rendered.projectNames.length})—— 增删 bot 须显式 --allow-scale`,
        ),
      );
    }
    return { issues, summary };
  }

  const newParsed = parseAncToml(rendered.text);
  const oldByName = projectByName(current);
  const newByName = projectByName(newParsed);

  const added = [...newByName.keys()].filter((n) => !oldByName.has(n));
  const removed = [...oldByName.keys()].filter((n) => !newByName.has(n));
  if ((added.length > 0 || removed.length > 0) && !opts.allowScale) {
    issues.push(
      err(
        "DIFF-SCALE",
        `project 增删须显式 --allow-scale(members 目录一次误操作不能静默上线/下线任何 bot)${added.length > 0 ? `;新增:${added.join(", ")}` : ""}${removed.length > 0 ? `;删除:${removed.join(", ")}` : ""}`,
      ),
    );
  }
  for (const n of added) summary.push(`+ project ${n}(新增)`);
  for (const n of removed) summary.push(`- project ${n}(删除)`);

  for (const [name, np] of newByName) {
    const op = oldByName.get(name);
    if (!op) continue;
    const changes: string[] = [];
    const oldPersona = op.options["append_system_prompt"];
    const newPersona = np.options["append_system_prompt"];
    if (typeof oldPersona === "string" && typeof newPersona === "string" && oldPersona !== newPersona) {
      changes.push(`persona 变更(sha256 ${sha256(oldPersona).slice(0, 12)} → ${sha256(newPersona).slice(0, 12)})`);
    }
    for (const key of ["model", "mode", "work_dir", "allowed_tools"]) {
      const ov = op.options[key];
      const nv = np.options[key];
      if (JSON.stringify(ov) !== JSON.stringify(nv)) changes.push(`${key}: ${fmt(ov)} → ${fmt(nv)}`);
    }
    const oldPlatform = op.platforms[0];
    const newPlatform = np.platforms[0];
    if (oldPlatform && newPlatform) {
      for (const key of ["app_id", "app_secret", "allow_from", "allow_chat"]) {
        const ov = oldPlatform.options[key];
        const nv = newPlatform.options[key];
        if (JSON.stringify(ov) !== JSON.stringify(nv)) changes.push(`${key}: ${fmt(ov)} → ${fmt(nv)}`);
      }
    }
    if (JSON.stringify(op.top["admin_from"]) !== JSON.stringify(np.top["admin_from"])) {
      changes.push(`admin_from: ${fmt(op.top["admin_from"])} → ${fmt(np.top["admin_from"])}`);
    }
    if (changes.length > 0) {
      summary.push(`~ project ${name}:${changes.join(";")}`);
    }
  }
  if (summary.length === 0) summary.push("无变更(与现行 config 语义一致)");

  return { issues, summary };
}
