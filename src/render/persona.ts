/**
 * persona.ts —— 七段式三层叠加渲染 + lint(M1-DESIGN §4.2)。
 *
 * 层次:persona-base.md(公司公共层)× roles/<r>/persona.md × members/<m>/persona.md。
 * 三条硬约定:
 *   1. 段落归属:段 3/4/6/7(数据来源/诚实条款/收资料 SOP/动态事实)只允许存在于 base 层
 *      (schema.checkBodySections 已在加载期拦截,这里再兜一道);
 *   2. 受控逃生门:role/member 层某段首行为 <!-- anc:replace --> 时替换而非追加,默认追加;
 *   3. persona lint(FAIL 拒渲):{{ 槽位残留 / 内容含 ''' / 内容含 ${(报来源层与行号);
 *      WARN:vault_root、homes 之外的绝对路径;「当前仅有/目前只有」句式(疑似烤死易变事实)。
 *
 * 本模块是纯函数(输入字符串与 Org 对象,输出字符串),不碰磁盘。
 */

import {
  Company,
  Member,
  parsePersonaBody,
  ParsedBody,
  Role,
} from "../org/schema";

export interface LintIssue {
  level: "ERROR" | "WARN";
  /** 来源层:文件路径或 "persona-base.md" / "routing-table" / "render" */
  source: string;
  line?: number;
  message: string;
}

export interface PersonaContext {
  /** persona-base.md 内容(anc 内置,vault 可覆盖 —— 由调用方读盘注入) */
  baseTemplate: string;
  company: Company;
  role: Role;
  member: Member;
  /** 来自 host.json(单机路径不进 org 仓库) */
  vaultRoot: string;
  /** ~/.anc 实际路径(用于绝对路径 WARN 白名单);可缺省 */
  ancHome?: string;
  /** routing.buildRoutingTable 产出 */
  routingTable: string;
}

export interface PersonaRender {
  /** 渲染产物;errors 非空时不得进入 config 渲染(拒渲) */
  text: string;
  errors: LintIssue[];
  warnings: LintIssue[];
}

const BASE_SOURCE = "persona-base.md";
/** base 必须提供的七段(归一化段名) */
const BASE_REQUIRED_SECTIONS: readonly string[] = [
  "身份",
  "职责",
  "数据来源",
  "诚实条款",
  "风格",
  "收资料SOP",
  "动态事实",
];

const PLATFORM_DISPLAY: Record<string, string> = { feishu: "飞书" };

function overlay(prev: string, section: { content: string; replace: boolean } | undefined): string {
  if (!section) return prev;
  if (section.replace) return section.content;
  if (prev === "") return section.content;
  if (section.content === "") return prev;
  return `${prev}\n\n${section.content}`;
}

function findSection(body: ParsedBody, name: string) {
  return body.sections.find((s) => s.name === name);
}

/** 逐行扫描作者层内容:''' 与 ${ 为 ERROR(带来源与行号),绝对路径与「仅有」句式为 WARN。 */
function scanLayer(
  raw: string,
  startLine: number,
  source: string,
  opts: { pathAllowPrefixes: string[]; warnChecks: boolean },
): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNo = startLine + i;
    if (line.includes("'''")) {
      issues.push({
        level: "ERROR",
        source,
        line: lineNo,
        message: "内容含 '''(TOML multi-line literal 定界符,literal 内不合法)—— 请改写该行,拒绝优于静默转义",
      });
    }
    if (line.includes("${")) {
      issues.push({
        level: "ERROR",
        source,
        line: lineNo,
        message: "内容含 ${(会被 cc-connect 的 env 替换吞掉)—— 请改写该行,拒绝优于静默转义",
      });
    }
    if (opts.warnChecks) {
      const pathRe = /(?:^|[\s("'`(,;:])((?:\/|~\/)[A-Za-z0-9_.\/~-]{2,})/g;
      let m: RegExpExecArray | null;
      while ((m = pathRe.exec(line)) !== null) {
        const p = m[1] as string;
        if (!opts.pathAllowPrefixes.some((prefix) => prefix !== "" && p.startsWith(prefix))) {
          issues.push({
            level: "WARN",
            source,
            line: lineNo,
            message: `出现 vault_root/homes 之外的绝对路径 \`${p}\` —— persona 不应指向渲染管线之外的路径`,
          });
        }
      }
      if (/当前仅有|目前仅有|当前只有|目前只有/.test(line)) {
        issues.push({
          level: "WARN",
          source,
          line: lineNo,
          message: "出现「当前仅有 / 目前只有」句式 —— 疑似把易变事实烤死在 persona 里;易变事实应引用 canonical 文件(SPEC §4.1 段 7)",
        });
      }
    }
  }
  return issues;
}

/** 七段式三层叠加渲染。 */
export function renderPersona(ctx: PersonaContext): PersonaRender {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const collect = (issues: LintIssue[]) => {
    for (const issue of issues) (issue.level === "ERROR" ? errors : warnings).push(issue);
  };

  const pathAllowPrefixes = [ctx.vaultRoot, "~/.anc", ctx.ancHome ?? ""];

  // --- 作者层 lint(先扫原文,行号可归位) ---
  collect(scanLayer(ctx.role.rawBody, ctx.role.bodyStartLine, ctx.role.file, { pathAllowPrefixes, warnChecks: true }));
  collect(scanLayer(ctx.member.rawBody, ctx.member.bodyStartLine, ctx.member.file, { pathAllowPrefixes, warnChecks: true }));
  collect(
    scanLayer(ctx.company.brief, ctx.company.briefStartLine, ctx.company.file, { pathAllowPrefixes, warnChecks: true }),
  );
  // base 与 routing 是受控产物:只查 ''' 与 ${,不做作者层 WARN
  collect(scanLayer(ctx.baseTemplate, 1, BASE_SOURCE, { pathAllowPrefixes, warnChecks: false }));
  collect(scanLayer(ctx.routingTable, 1, "routing-table", { pathAllowPrefixes, warnChecks: false }));

  // --- base 解析 ---
  const base = parsePersonaBody(ctx.baseTemplate, 1);
  for (const name of BASE_REQUIRED_SECTIONS) {
    if (!findSection(base, name)) {
      errors.push({ level: "ERROR", source: BASE_SOURCE, message: `base 层缺少必需段 \`## ${name}\`(七段式,M1-DESIGN §4.2)` });
    }
  }
  if (base.preamble !== "") {
    errors.push({ level: "ERROR", source: BASE_SOURCE, line: base.preambleLine, message: "base 层不允许 H2 段之外的正文" });
  }

  // --- 变量替换(槽位只在 base 层;role/member 层的 {{ 会被 lint 抓残留) ---
  const vars: Record<string, string> = {
    company_name: ctx.company.name,
    company_id: ctx.company.id,
    company_brief: ctx.company.brief,
    role_title: ctx.role.title,
    role_name: ctx.role.role,
    display_name: ctx.member.display_name,
    member_name: ctx.member.name,
    platform: ctx.company.platform,
    platform_name: PLATFORM_DISPLAY[ctx.company.platform] ?? ctx.company.platform,
    vault_root: ctx.vaultRoot,
    routing_table: ctx.routingTable,
    timezone: ctx.company.timezone,
    language: ctx.company.language,
  };
  const substitute = (s: string): string =>
    s.replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) => (key in vars ? (vars[key] as string) : whole));

  const baseSection = (name: string): string => {
    const s = findSection(base, name);
    return s ? substitute(s.content) : "";
  };

  // --- 三层叠加(职责/风格/术语表可被 role/member 层追加或 anc:replace 替换) ---
  let duties = baseSection("职责");
  let style = baseSection("风格");
  let glossary = baseSection("术语表");
  for (const layer of [ctx.role.body, ctx.member.body]) {
    duties = overlay(duties, findSection(layer, "职责"));
    style = overlay(style, findSection(layer, "风格"));
    glossary = overlay(glossary, findSection(layer, "术语表"));
  }
  const audience = ctx.member.body.preamble;

  const out: string[] = [];
  const push = (heading: string, content: string) => {
    out.push(`## ${heading}`);
    if (content.trim() !== "") out.push("", content.trim());
    out.push("");
  };
  push("身份", baseSection("身份"));
  push("职责", duties);
  push("数据来源", baseSection("数据来源"));
  push("诚实条款", baseSection("诚实条款"));
  push("风格", glossary.trim() !== "" ? `${style.trim() === "" ? "" : `${style.trim()}\n\n`}### 术语表\n\n${glossary.trim()}` : style);
  push("收资料 SOP", baseSection("收资料SOP"));
  push("动态事实", baseSection("动态事实"));
  if (audience.trim() !== "") push("服务对象", audience);
  const text = `${out.join("\n").trim()}\n`;

  // --- 渲染后置检:槽位残留(未知 {{}} 或作者层写入的 {{) ---
  const leftover = text.match(/\{\{[^\n}]*\}?\}?/g);
  if (leftover) {
    const uniq = [...new Set(leftover)];
    errors.push({
      level: "ERROR",
      source: "render",
      message: `渲染产物残留 {{ 槽位:${uniq.join(" , ")} —— 未知槽位名或作者层误写模板语法`,
    });
  }
  // 终检兜底:若最终产物仍含 '''/${(如变量值本身携带),给出 render 级错误
  if (text.includes("'''") && !errors.some((e) => e.message.includes("'''"))) {
    errors.push({ level: "ERROR", source: "render", message: "渲染产物含 '''(来源为变量值),拒渲" });
  }
  if (text.includes("${") && !errors.some((e) => e.message.includes("${"))) {
    errors.push({ level: "ERROR", source: "render", message: "渲染产物含 ${(来源为变量值),拒渲" });
  }

  return { text, errors, warnings };
}
