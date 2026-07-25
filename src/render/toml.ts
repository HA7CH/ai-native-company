/**
 * toml.ts —— config.toml 全量生成器 + ''' 转义纪律 + mini round-trip 解析器
 * (M1-DESIGN §4.1/§4.3;裁决 1「全量生成不 patch」、裁决 4「不写完整 TOML parser」)。
 *
 * - persona 用 ''' multi-line literal(零转义;开头三引号后紧跟换行,标准吞首换行);
 *   literal 内不得出现 '''(persona lint 已拒渲,这里再断言)。
 * - 其余字符串统一 basic string + 最小转义(\ / " / 控制字符);key 全部由生成器白名单产出。
 * - 指纹头 inputs = org 树 + host 相关字段 + gateway-extra.toml 的联合 hash ——
 *   只改主机层输入同样触发重渲染,不会被「org 未变」短路漏掉。
 * - mini round-trip 解析器只认「本生成器产出形态」,但取值语义必须与真 TOML 一致:
 *   其值模型(尤其多行 literal 的尾换行归属、数组元素转义)已与两个独立 TOML 实现
 *   逐例对拍,期望值固化在 test/toml-roundtrip.test.ts。cc-connect 启动烟测继续作为
 *   端到端 oracle 补位(W1 实测项 ③)。畸形手改文件不在保护范围 —— 手改本身即事故。
 *
 * 本模块为纯函数(Org → 字符串),不碰磁盘。
 */

import { createHash } from "node:crypto";
import { DEVBOT_ROLE, Member, Org, Role } from "../org/schema";
import { orderMembers } from "../org/load";

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

export function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** 确定性 JSON 序列化(对象键排序)——指纹 hash 的地基。 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "undefined") return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  throw new Error(`stableStringify: 不支持的类型 ${typeof v}`);
}

/** TOML basic string,最小转义:\、"、控制字符。 */
export function basicString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0) as number;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function stringArray(items: string[]): string {
  return `[${items.map(basicString).join(", ")}]`;
}

/**
 * ''' multi-line literal:开头三引号后紧跟换行(TOML 吞掉该换行),闭合 ''' 独占一行。
 * 内容不得含 '''(persona lint 拒渲兜底)。
 *
 * 尾部换行归一化为恰好一个 —— 闭合定界符必须独占一行才能被 mini 解析器按行识别。
 * 这是本函数对内容的唯一改写;改写后的确切值由 literalBlockValue() 给出(hash 锚点用它)。
 */
export function literalBlock(s: string): string {
  if (s.includes("'''")) {
    throw new Error("literalBlock: 内容含 '''(persona lint 应已拒渲)—— 渲染器拒绝产出非法 TOML");
  }
  const body = s.replace(/\n+$/, "");
  return `'''\n${body}\n'''`;
}

/**
 * literalBlock(s) 写进文件后、被 TOML 解析器读回的确切值。
 *
 * 依据 TOML 1.0「多行 literal 只吞开定界符后紧跟的那个换行,其余内容原样」——
 * 所以末行结尾那个换行属于值,不属于定界符。期望值已由两个独立 TOML 实现对拍确认,
 * 并固化为 test/toml-roundtrip.test.ts 的字面断言(本库零运行时依赖,不引真解析器)。
 */
export function literalBlockValue(s: string): string {
  return `${s.replace(/\n+$/, "")}\n`;
}

export function envVarSafeName(name: string): string {
  return name.toUpperCase().replace(/-/g, "_");
}

/** member 的飞书 app_secret 环境变量名(secrets.env,M1-DESIGN §3.4)。 */
export function feishuSecretEnv(memberName: string): string {
  return `ANC_FEISHU_SECRET_${envVarSafeName(memberName)}`;
}

/** fallback provider 的 api_key 环境变量名(M1-DESIGN §3.2)。 */
export function providerKeyEnv(providerName: string): string {
  return `ANC_PROVIDER_KEY_${envVarSafeName(providerName)}`;
}

export function projectName(companyId: string, memberName: string): string {
  return `${companyId}-${memberName}`;
}

/**
 * project 级禁用命令(上游 `disabled_commands`,M1-DESIGN §9 裁决 13 的运行时闭环)。
 *
 * - `mode`:角色 bot 必禁 —— /mode 非特权命令且不校验管理员,任何白名单用户可提权到
 *   bypassPermissions(SPEC §7 红线)。devbot 本就是最高权限档,禁之无意义,予以豁免。
 * - `provider` / `model`:全员禁 —— 二者会回写 config.toml 制造指纹漂移,与「全量生成、
 *   config 归 anc 独占」的契约冲突;切模型/切 provider 走 org 真相源 + 重新 deploy。
 */
export function disabledCommands(isDevbot: boolean): string[] {
  return isDevbot ? ["provider", "model"] : ["mode", "provider", "model"];
}

/**
 * org 的 BCP-47 language → 上游认得的取值。
 *
 * 上游 switch(main.go:331-345)只认下列字面量,其余一律落 `LangAuto`;而**仅当** LangAuto 时
 * 才注册语言回写钩子(main.go:801-805),第一条中文消息就会触发 SaveLanguage 把我们全量生成的
 * config.toml 就地 patch(顺带经 formatTOML 删空段、插空行)—— 指纹立即失配,`anc deploy config`
 * 会把上游的自动回写误判成人为手改事故。
 *
 * 所以 org 侧可写 BCP-47(zh-CN),但渲染必须映射成上游字面量;不可映射的取值拒渲,绝不原样透传。
 */
const GATEWAY_LANGUAGES: Record<string, string> = {
  zh: "zh",
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-tw": "zh-TW",
  "zh-hant": "zh-TW",
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  ja: "ja",
  "ja-jp": "ja",
  es: "es",
  "es-es": "es",
};

export function gatewayLanguage(language: string): string {
  const mapped = GATEWAY_LANGUAGES[language.trim().toLowerCase()];
  if (mapped === undefined) {
    throw new Error(
      `renderConfig: language \`${language}\` 无法映射到 cc-connect 认得的取值 —— ` +
        `原样透传会落进 auto 档并触发上游回写 config(指纹漂移)。支持:${Object.keys(GATEWAY_LANGUAGES).join(", ")}`,
    );
  }
  return mapped;
}

/** 启用成员按渲染顺序(目录名排序 + devbot 殿后)。 */
export function enabledMembersInOrder(org: Org): Member[] {
  return orderMembers(org.members.filter((m) => !m.disabled));
}

// ---------------------------------------------------------------------------
// 全量生成器
// ---------------------------------------------------------------------------

export interface HostInputs {
  /** vault 本机路径(host.json;单机路径不进 org 仓库) */
  vaultRoot: string;
  /** ~/.anc 实际路径 */
  ancHome: string;
  /** gateway data_dir;缺省 = <ancHome>/data */
  dataDir?: string;
}

export interface RenderConfigInput {
  org: Org;
  /** member name → 渲染后 persona(persona.ts 产出,errors 为空才允许进来) */
  personas: Record<string, string>;
  host: HostInputs;
  ancVersion: string;
  /** ISO 时间戳(由调用方注入 —— 可测性即正确性) */
  now: string;
  /** ~/.anc/gateway-extra.toml 原文(可选,原样并入文件尾部;裁决 12) */
  gatewayExtra?: string;
}

export interface RenderedConfig {
  text: string;
  inputsHash: string;
  /**
   * project 名 → persona 落进 TOML 后的确切值的 SHA256(round-trip 校验的对拍锚点)。
   * 锚点取 literalBlockValue(persona) 而非 persona 原文:literalBlock 会把尾部换行归一为
   * 恰好一个,锚点必须对准「gateway 真正会读到的字节」。persona.ts 的产物本就以恰好一个
   * 换行结尾,故实际管线中二者逐字节相同(该不变量由 toml-roundtrip 测试钉住)。
   */
  personaSha: Record<string, string>;
  projectNames: string[];
}

export const EXTRA_BEGIN = "# anc:extra-begin —— 以下内容原样并入自 ~/.anc/gateway-extra.toml(round-trip 校验跳过,diff 单独标示)";
export const EXTRA_END = "# anc:extra-end";

export const FINGERPRINT_RE = /^# anc:generated v=(\S+) inputs=([0-9a-f]{64}) at=(\S+)$/;

/** 指纹 inputs 联合 hash:org 树 + personas + host 相关字段 + gateway-extra。 */
export function computeInputsHash(input: RenderConfigInput): string {
  const { org, personas, host, gatewayExtra } = input;
  return sha256(
    stableStringify({
      company: org.company,
      roles: org.roles,
      members: org.members,
      personas,
      host: { vaultRoot: host.vaultRoot, ancHome: host.ancHome, dataDir: host.dataDir ?? `${host.ancHome}/data` },
      gatewayExtra: gatewayExtra ?? null,
    }),
  );
}

function resolveModel(member: Member, role: Role, org: Org): string {
  return member.model !== "" ? member.model : role.model !== "" ? role.model : org.company.defaults.model;
}

/** org → config.toml 全量文本。不 patch:整个文件由本函数产出,手改视为事故(裁决 1)。 */
export function renderConfig(input: RenderConfigInput): RenderedConfig {
  const { org, personas, host } = input;
  const members = enabledMembersInOrder(org);
  const dataDir = host.dataDir ?? `${host.ancHome}/data`;
  const inputsHash = computeInputsHash(input);
  const personaSha: Record<string, string> = {};
  const projectNames: string[] = [];

  const adminOpenIds: string[] = [];
  for (const adminName of org.company.admins) {
    const m = org.members.find((mm) => mm.name === adminName);
    if (!m) throw new Error(`renderConfig: admins 引用了不存在的 member \`${adminName}\`(load 应已拦截)`);
    adminOpenIds.push(m.feishu.open_id);
  }

  const L: string[] = [];
  L.push(`# anc:generated v=${input.ancVersion} inputs=${inputsHash} at=${input.now}`);
  L.push("# 本文件由 anc 全量生成;手改视为事故 —— 修改请编辑 org 真相源后运行 anc deploy config(SPEC §4.2)。");
  L.push("");
  L.push(`language = ${basicString(gatewayLanguage(org.company.language))}`);
  L.push(`data_dir = ${basicString(dataDir)}`);
  L.push("");
  L.push("[log]");
  // 写全 level 而非留空段:上游 formatTOML 会删除「表头后只跟空行」的空段(config.go:1548-1613),
  // 一旦发生任何回写就会把空 [log] 抹掉 → 与渲染产物失配。[log] 合法键只有 level(config.go:603)。
  L.push(`level = ${basicString("info")}`);
  L.push("");
  L.push("[display]");
  L.push(`mode = ${basicString("full")}`);

  for (const member of members) {
    const role = org.roles[member.role];
    if (!role) throw new Error(`renderConfig: member \`${member.name}\` 的角色 \`${member.role}\` 不存在(load 应已拦截)`);
    const persona = personas[member.name];
    if (persona === undefined) throw new Error(`renderConfig: member \`${member.name}\` 缺 persona(渲染管线错误)`);
    const isDevbot = role.role === DEVBOT_ROLE;
    const pname = projectName(org.company.id, member.name);
    projectNames.push(pname);
    personaSha[pname] = sha256(literalBlockValue(persona));

    L.push("");
    L.push("[[projects]]");
    L.push(`name = ${basicString(pname)}`);
    // admin_from 必须写 project 顶层(写进 platforms.options 会被上游静默忽略 —— 渲染器硬编码位置)
    L.push(`admin_from = ${basicString(adminOpenIds.join(","))}`);
    L.push("reset_on_idle_mins = 30");
    // 运行时红线:/mode 不在上游 privilegedCommands 表(engine.go:1004),cmdMode 也不校验管理员,
    // 任何 allow_from 内的用户发 `/mode bypassPermissions` 即可提权角色 bot —— 渲染 config 挡不住,
    // 只能靠 disabled_commands(config.go:506,main.go:466 已 wired)。SPEC §7 红线的运行时闭环。
    // /provider 与 /model 会 patchProjectAgentOption 回写 config.toml(config.go:1164/2593),
    // 破坏「config.toml 归 anc 独占、手改视为事故」的契约 —— 全员禁,devbot 亦然。
    L.push(`disabled_commands = ${stringArray(disabledCommands(isDevbot))}`);

    if (org.company.defaults.auto_compress_max_tokens !== undefined) {
      L.push("");
      L.push("[projects.auto_compress]");
      // enabled 必须显式写 true:上游 `Enabled *bool` 默认 nil(config.go:442 注释 "default false"),
      // main.go:619 `if Enabled != nil && *Enabled` 直接短路 —— 只写 max_tokens 是语法合法、
      // 语义完全失效的死配置。min_gap_mins 不渲染,用上游默认 30 分钟。
      L.push("enabled = true");
      L.push(`max_tokens = ${org.company.defaults.auto_compress_max_tokens}`);
    }

    L.push("");
    L.push("[projects.agent]");
    L.push(`type = ${basicString("claudecode")}`);
    L.push("");
    L.push("[projects.agent.options]");
    L.push(`work_dir = ${basicString(isDevbot ? host.vaultRoot : `${host.ancHome}/homes/${member.name}`)}`);
    L.push(`model = ${basicString(resolveModel(member, role, org))}`);
    L.push(`mode = ${basicString(role.mode)}`);
    if (role.allowed_tools.length > 0) {
      L.push(`allowed_tools = ${stringArray(role.allowed_tools)}`);
    }
    L.push(`append_system_prompt = ${literalBlock(persona)}`);

    if (org.company.fallback_provider) {
      const fp = org.company.fallback_provider;
      L.push("");
      L.push("[[projects.agent.providers]]");
      L.push(`name = ${basicString(fp.name)}`);
      L.push(`base_url = ${basicString(fp.base_url)}`);
      L.push(`model = ${basicString(fp.model)}`);
      L.push(`api_key = ${basicString(`\${${providerKeyEnv(fp.name)}}`)}`);
    }

    L.push("");
    L.push("[[projects.platforms]]");
    L.push(`type = ${basicString("feishu")}`);
    L.push("");
    L.push("[projects.platforms.options]");
    L.push(`app_id = ${basicString(member.feishu.app_id)}`);
    L.push(`app_secret = ${basicString(`\${${feishuSecretEnv(member.name)}}`)}`);
    const allowFrom: string[] = [];
    for (const id of [member.feishu.open_id, ...member.feishu.extra_allow_from, ...adminOpenIds]) {
      if (!allowFrom.includes(id)) allowFrom.push(id); // Set 语义去重(抄 access.sh)
    }
    // 必须是逗号串,不能是 TOML 数组 —— 上游 14 个 platform 一律 `opts["allow_from"].(string)`
    // (v1.3.4 platform/feishu/feishu.go:222),数组解出 []any 断言失败得空串,而
    // core.AllowList 对空串 `return true` = 放行任意用户(core/message.go)。数组形态即 fail-open。
    // 对照:allowed_tools 才是数组(claudecode.go:152 `.([]any)`),两者不可混用。
    L.push(`allow_from = ${basicString(allowFrom.join(","))}`);
    if (member.feishu.allow_chat.length > 0) {
      L.push(`allow_chat = ${basicString(member.feishu.allow_chat.join(","))}`);
    }
  }

  if (input.gatewayExtra !== undefined && input.gatewayExtra.trim() !== "") {
    L.push("");
    L.push(EXTRA_BEGIN);
    L.push(input.gatewayExtra.replace(/\n+$/, ""));
    L.push(EXTRA_END);
  }

  L.push("");
  return { text: L.join("\n"), inputsHash, personaSha, projectNames };
}

// ---------------------------------------------------------------------------
// mini round-trip 解析器(只认自家产出形态)
// ---------------------------------------------------------------------------

export type TomlPrim = string | number | boolean | string[];

export interface ParsedPlatform {
  top: Record<string, TomlPrim>;
  options: Record<string, TomlPrim>;
}

export interface ParsedProject {
  top: Record<string, TomlPrim>;
  autoCompress?: Record<string, TomlPrim>;
  agent: Record<string, TomlPrim>;
  options: Record<string, TomlPrim>;
  providers: Record<string, TomlPrim>[];
  platforms: ParsedPlatform[];
  headerLine: number;
}

export interface ParsedConfig {
  fingerprint?: { v: string; inputs: string; at: string };
  topLevel: Record<string, TomlPrim>;
  tables: Record<string, Record<string, TomlPrim>>;
  projects: ParsedProject[];
  extraRaw?: string;
  errors: { line: number; message: string }[];
}

const KNOWN_GLOBAL_TABLES = new Set(["log", "display"]);

function parseBasicString(text: string, lineNo: number, errors: ParsedConfig["errors"]): string | undefined {
  // text 以 " 开头且应整体为一个 basic string
  let out = "";
  let i = 1;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\") {
      const n = text[i + 1];
      if (n === "\\") out += "\\";
      else if (n === '"') out += '"';
      else if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "r") out += "\r";
      else if (n === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          errors.push({ line: lineNo, message: "非法 \\u 转义" });
          return undefined;
        }
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
        continue;
      } else {
        errors.push({ line: lineNo, message: `非自家产出形态:未知转义 \\${n ?? ""}` });
        return undefined;
      }
      i += 2;
    } else if (c === '"') {
      if (text.slice(i + 1).trim() !== "") {
        errors.push({ line: lineNo, message: "非自家产出形态:字符串后有多余内容" });
        return undefined;
      }
      return out;
    } else {
      out += c;
      i += 1;
    }
  }
  errors.push({ line: lineNo, message: "字符串未闭合" });
  return undefined;
}

function parseArrayValue(text: string, lineNo: number, errors: ParsedConfig["errors"]): string[] | undefined {
  if (!text.endsWith("]")) {
    errors.push({ line: lineNo, message: "非自家产出形态:数组须单行闭合" });
    return undefined;
  }
  const inner = text.slice(1, -1).trim();
  if (inner === "") return [];
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    while (inner[i] === " " || inner[i] === ",") i++;
    if (i >= inner.length) break;
    if (inner[i] !== '"') {
      errors.push({ line: lineNo, message: "非自家产出形态:数组元素须为 basic string" });
      return undefined;
    }
    // 找到未被转义的闭引号
    let j = i + 1;
    let value = "";
    let closed = false;
    while (j < inner.length) {
      const c = inner[j] as string;
      if (c === "\\") {
        const n = inner[j + 1];
        if (n === "\\") value += "\\";
        else if (n === '"') value += '"';
        else if (n === "n") value += "\n";
        else if (n === "t") value += "\t";
        else if (n === "r") value += "\r";
        else if (n === "u") {
          // basicString 对控制字符产出 \uXXXX —— 数组元素与标量必须同构,否则自家产出读不回
          const hex = inner.slice(j + 2, j + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            errors.push({ line: lineNo, message: "数组元素非法 \\u 转义" });
            return undefined;
          }
          value += String.fromCharCode(parseInt(hex, 16));
          j += 6;
          continue;
        } else {
          errors.push({ line: lineNo, message: `非自家产出形态:数组元素未知转义 \\${n ?? ""}` });
          return undefined;
        }
        j += 2;
      } else if (c === '"') {
        closed = true;
        break;
      } else {
        value += c;
        j += 1;
      }
    }
    if (!closed) {
      errors.push({ line: lineNo, message: "数组元素字符串未闭合" });
      return undefined;
    }
    out.push(value);
    i = j + 1;
  }
  return out;
}

/** 解析 anc 渲染器自家产出的 config.toml。手改/外来形态 → errors(不猜)。 */
export function parseAncToml(text: string): ParsedConfig {
  const parsed: ParsedConfig = { topLevel: {}, tables: {}, projects: [], errors: [] };
  const lines = text.split("\n");

  const first = lines[0] ?? "";
  const fp = FINGERPRINT_RE.exec(first);
  if (fp) parsed.fingerprint = { v: fp[1] as string, inputs: fp[2] as string, at: fp[3] as string };

  type Target = Record<string, TomlPrim>;
  let target: Target = parsed.topLevel;
  let currentProject: ParsedProject | null = null;
  let inExtra = false;
  const extraLines: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const lineNo = i + 1;

    if (inExtra) {
      if (line.startsWith(EXTRA_END)) {
        inExtra = false;
        parsed.extraRaw = extraLines.join("\n");
      } else {
        extraLines.push(line);
      }
      i++;
      continue;
    }
    if (line.startsWith("# anc:extra-begin")) {
      inExtra = true;
      i++;
      continue;
    }
    if (line.trim() === "" || line.startsWith("#")) {
      i++;
      continue;
    }

    // 只认单层 [name];[[name]] 形态在上面按字面量逐一匹配,漏网的一律报错(`[log]]` 不放过)
    const tableMatch = /^\[([A-Za-z0-9_.]+)\]$/.exec(line.trim());
    if (line.trim().startsWith("[")) {
      const t = line.trim();
      if (t === "[[projects]]") {
        currentProject = { top: {}, agent: {}, options: {}, providers: [], platforms: [], headerLine: lineNo };
        parsed.projects.push(currentProject);
        target = currentProject.top;
      } else if (t === "[projects.auto_compress]") {
        if (!currentProject) {
          parsed.errors.push({ line: lineNo, message: "projects 子表出现在 [[projects]] 之前" });
          target = {};
        } else {
          currentProject.autoCompress = {};
          target = currentProject.autoCompress;
        }
      } else if (t === "[projects.agent]") {
        if (!currentProject) {
          parsed.errors.push({ line: lineNo, message: "projects 子表出现在 [[projects]] 之前" });
          target = {};
        } else {
          target = currentProject.agent;
        }
      } else if (t === "[projects.agent.options]") {
        if (!currentProject) {
          parsed.errors.push({ line: lineNo, message: "projects 子表出现在 [[projects]] 之前" });
          target = {};
        } else {
          target = currentProject.options;
        }
      } else if (t === "[[projects.agent.providers]]") {
        if (!currentProject) {
          parsed.errors.push({ line: lineNo, message: "projects 子表出现在 [[projects]] 之前" });
          target = {};
        } else {
          const provider: Record<string, TomlPrim> = {};
          currentProject.providers.push(provider);
          target = provider;
        }
      } else if (t === "[[projects.platforms]]") {
        if (!currentProject) {
          parsed.errors.push({ line: lineNo, message: "projects 子表出现在 [[projects]] 之前" });
          target = {};
        } else {
          const platform: ParsedPlatform = { top: {}, options: {} };
          currentProject.platforms.push(platform);
          target = platform.top;
        }
      } else if (t === "[projects.platforms.options]") {
        const platform = currentProject?.platforms[currentProject.platforms.length - 1];
        if (!platform) {
          parsed.errors.push({ line: lineNo, message: "[projects.platforms.options] 出现在 [[projects.platforms]] 之前" });
          target = {};
        } else {
          target = platform.options;
        }
      } else if (tableMatch && KNOWN_GLOBAL_TABLES.has(tableMatch[1] as string)) {
        const name = tableMatch[1] as string;
        parsed.tables[name] = parsed.tables[name] ?? {};
        target = parsed.tables[name] as Target;
      } else {
        parsed.errors.push({ line: lineNo, message: `非自家产出形态:未知表 \`${t}\`` });
        target = {};
      }
      i++;
      continue;
    }

    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!kv) {
      parsed.errors.push({ line: lineNo, message: `非自家产出形态:无法解析的行 \`${line.trim()}\`` });
      i++;
      continue;
    }
    const key = kv[1] as string;
    const rawValue = (kv[2] as string).trim();
    if (rawValue === "'''") {
      // multi-line literal:逐行收集到单独一行的 '''
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (lines[j] === "'''") {
          closed = true;
          break;
        }
        body.push(lines[j] as string);
        j++;
      }
      if (!closed) {
        parsed.errors.push({ line: lineNo, message: "multi-line literal 未闭合" });
        i = lines.length;
        continue;
      }
      // 每行末尾的换行都属于值:闭合 ''' 之前的那个换行是内容的一部分,不是定界符的
      // (TOML 1.0 只吞开定界符后紧跟的那个换行)。body 为空才是空串。
      target[key] = body.length === 0 ? "" : `${body.join("\n")}\n`;
      i = j + 1;
      continue;
    }
    if (rawValue.startsWith('"')) {
      const v = parseBasicString(rawValue, lineNo, parsed.errors);
      if (v !== undefined) target[key] = v;
    } else if (rawValue.startsWith("[")) {
      const v = parseArrayValue(rawValue, lineNo, parsed.errors);
      if (v !== undefined) target[key] = v;
    } else if (/^-?\d+$/.test(rawValue)) {
      target[key] = parseInt(rawValue, 10);
    } else if (rawValue === "true" || rawValue === "false") {
      target[key] = rawValue === "true"; // auto_compress.enabled(裸 bool,TOML 只认小写字面量)
    } else {
      parsed.errors.push({ line: lineNo, message: `非自家产出形态:无法解析的值 \`${rawValue}\`` });
    }
    i++;
  }

  if (inExtra) parsed.errors.push({ line: lines.length, message: "gateway-extra 段未闭合(缺 # anc:extra-end)" });
  return parsed;
}
