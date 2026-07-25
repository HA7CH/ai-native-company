/**
 * frontmatter.ts —— 零依赖 YAML 子集解析器(M1-DESIGN §3)。
 *
 * 只支持 org 真相源 frontmatter 需要的子集:
 *   - 标量:裸字符串 / 双引号字符串(仅 \\ 与 \" 转义)/ 整数与小数 / true|false
 *   - 字符串数组:单行内联形式 `[a, "b c"]`(元素为裸字符串或双引号字符串)
 *   - 一层嵌套映射:`key:` 后接固定缩进的 `sub: value` 行(值为标量或字符串数组)
 *   - `#` 注释(引号外)与空行
 *
 * 越界形态(块列表、多行标量、锚点/别名、单引号、内联映射、二层嵌套、tab 缩进、
 * 重复键、null)一律报错并给出行号 —— 拒绝优于猜测。
 */

export type FmScalar = string | number | boolean;
export type FmMapValue = FmScalar | string[];
export type FmMap = Record<string, FmMapValue>;
export type FmValue = FmScalar | string[] | FmMap;

export interface FmIssue {
  line: number; // 1-based,针对整个文件
  message: string;
}

export interface FmResult {
  data: Record<string, FmValue>;
  /** 键(顶层 "key" 或嵌套 "key.sub")→ 所在行号(1-based) */
  keyLines: Record<string, number>;
  body: string;
  /** body 第一行在原文件中的行号(1-based) */
  bodyStartLine: number;
  errors: FmIssue[];
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(.*)$/;

/** 去除引号外的 `#` 注释(注释须在行首或空白后),并去尾空白。 */
export function stripComment(s: string): string {
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      // 数被转义的反斜杠:奇数个 = 该引号被转义
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) inQuote = !inQuote;
    } else if (c === "#" && !inQuote) {
      const prev = i === 0 ? "" : s[i - 1];
      if (i === 0 || prev === " " || prev === "\t") return s.slice(0, i).replace(/\s+$/, "");
    }
  }
  return s.replace(/\s+$/, "");
}

interface ScalarParse {
  value?: FmScalar;
  error?: string;
}

function parseQuoted(text: string): { value?: string; rest?: string; error?: string } {
  // text[0] === '"'
  let out = "";
  let i = 1;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") {
      const n = text[i + 1];
      if (n === "\\") {
        out += "\\";
        i += 2;
      } else if (n === '"') {
        out += '"';
        i += 2;
      } else {
        return { error: `不支持的转义 \\${n ?? ""}(双引号字符串仅支持 \\\\ 与 \\")` };
      }
    } else if (c === '"') {
      return { value: out, rest: text.slice(i + 1) };
    } else {
      out += c;
      i += 1;
    }
  }
  return { error: "双引号字符串未闭合" };
}

function parseScalar(text: string): ScalarParse {
  if (text.startsWith('"')) {
    const q = parseQuoted(text);
    if (q.error) return { error: q.error };
    if ((q.rest ?? "").trim() !== "") return { error: "双引号字符串后有多余内容" };
    return { value: q.value ?? "" };
  }
  if (text.startsWith("'")) return { error: "单引号字符串不在子集内,请改用双引号" };
  if (text.startsWith("|") || text.startsWith(">")) return { error: "多行标量(|/>)不在子集内" };
  if (text.startsWith("&") || text.startsWith("*")) return { error: "锚点/别名(&/*)不在子集内;如需字面量请用双引号" };
  if (text.startsWith("{")) return { error: "内联映射({})不在子集内" };
  if (text === "null" || text === "~") return { error: "null 不在子集内,请写显式值(\"\" 或删除该键)" };
  if (text === "true") return { value: true };
  if (text === "false") return { value: false };
  if (/^-?\d+$/.test(text)) return { value: parseInt(text, 10) };
  if (/^-?\d+\.\d+$/.test(text)) return { value: parseFloat(text) };
  return { value: text };
}

function parseArray(text: string): { value?: string[]; error?: string } {
  // text 以 [ 开头
  if (!text.endsWith("]")) return { error: "数组必须单行闭合,如 [a, b]" };
  const inner = text.slice(1, -1).trim();
  if (inner === "") return { value: [] };
  const elems: string[] = [];
  let cur = "";
  let inQuote = false;
  const rawElems: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string;
    if (c === '"') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && inner[j] === "\\"; j--) backslashes++;
      if (backslashes % 2 === 0) inQuote = !inQuote;
      cur += c;
    } else if (c === "," && !inQuote) {
      rawElems.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  rawElems.push(cur);
  for (const rawElem of rawElems) {
    const e = rawElem.trim();
    if (e === "") return { error: "数组含空元素(多余逗号?)" };
    if (e.startsWith('"')) {
      const q = parseQuoted(e);
      if (q.error) return { error: `数组元素:${q.error}` };
      if ((q.rest ?? "").trim() !== "") return { error: "数组元素:双引号字符串后有多余内容" };
      elems.push(q.value ?? "");
    } else {
      if (e.startsWith("'")) return { error: "数组元素:单引号字符串不在子集内,请改用双引号" };
      if (e.includes('"')) return { error: "数组元素:裸字符串中不允许出现双引号" };
      elems.push(e);
    }
  }
  return { value: elems };
}

function parseValueText(text: string): { value?: FmMapValue; error?: string } {
  if (text.startsWith("[")) return parseArray(text);
  return parseScalar(text);
}

/** 解析带 frontmatter 的 markdown 文件。任何错误收集进 errors(带行号),不抛异常。 */
export function parseFrontmatter(content: string): FmResult {
  const lines = content.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const result: FmResult = { data: {}, keyLines: {}, body: "", bodyStartLine: 1, errors: [] };
  const err = (line: number, message: string) => result.errors.push({ line, message });

  if (lines[0] !== "---") {
    err(1, "文件必须以 `---` frontmatter 分隔线开头");
    result.body = content;
    return result;
  }
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    err(lines.length, "frontmatter 未闭合(缺少结尾 `---`)");
    return result;
  }
  result.body = lines.slice(close + 1).join("\n");
  result.bodyStartLine = close + 2;

  let i = 1;
  while (i < close) {
    const lineNo = i + 1;
    const raw = lines[i] as string;
    const stripped = stripComment(raw);
    if (stripped.trim() === "") {
      i++;
      continue;
    }
    if (/^\t/.test(raw)) {
      err(lineNo, "缩进不允许使用 tab,请用空格");
      i++;
      continue;
    }
    if (/^\s/.test(raw)) {
      err(lineNo, "缩进越界:此处不应有缩进(嵌套映射仅支持一层,且须紧跟其父键)");
      i++;
      continue;
    }
    if (/^-\s/.test(stripped) || stripped === "-") {
      err(lineNo, "块列表(`- item`)不在子集内,请用单行数组 [a, b]");
      i++;
      continue;
    }
    const m = KEY_RE.exec(stripped);
    if (!m) {
      err(lineNo, "无法解析的行(子集仅支持 `key: value` / `key: [..]` / 一层嵌套映射)");
      i++;
      continue;
    }
    const key = m[1] as string;
    const rest = (m[2] as string).trim();
    if (Object.prototype.hasOwnProperty.call(result.data, key)) {
      err(lineNo, `重复的键 \`${key}\``);
    }
    if (rest === "") {
      // 一层嵌套映射
      const map: FmMap = {};
      let nestedIndent = -1;
      let consumedAny = false;
      let j = i + 1;
      while (j < close) {
        const nraw = lines[j] as string;
        const nstripped = stripComment(nraw);
        if (nstripped.trim() === "") {
          j++;
          continue;
        }
        if (!/^\s/.test(nraw)) break; // 回到顶层
        const nLineNo = j + 1;
        if (/^\t/.test(nraw)) {
          err(nLineNo, "缩进不允许使用 tab,请用空格");
          j++;
          consumedAny = true;
          continue;
        }
        const indent = (/^( +)/.exec(nraw) as RegExpExecArray)[1]!.length;
        if (nestedIndent === -1) nestedIndent = indent;
        if (indent !== nestedIndent) {
          err(nLineNo, `缩进越界:嵌套映射仅支持一层,缩进须一致(此处 ${indent} 空格,期望 ${nestedIndent})`);
          j++;
          consumedAny = true;
          continue;
        }
        const ntrim = nstripped.trim();
        if (/^-\s/.test(ntrim) || ntrim === "-") {
          err(nLineNo, "块列表(`- item`)不在子集内,请用单行数组 [a, b]");
          j++;
          consumedAny = true;
          continue;
        }
        const nm = KEY_RE.exec(ntrim);
        if (!nm) {
          err(nLineNo, "无法解析的嵌套行(子集仅支持 `sub: value`)");
          j++;
          consumedAny = true;
          continue;
        }
        const nkey = nm[1] as string;
        const nrest = (nm[2] as string).trim();
        consumedAny = true;
        if (nrest === "") {
          err(nLineNo, `\`${key}.${nkey}\`:嵌套映射仅支持一层,值不能再嵌套`);
          j++;
          continue;
        }
        if (Object.prototype.hasOwnProperty.call(map, nkey)) {
          err(nLineNo, `重复的键 \`${key}.${nkey}\``);
        }
        const pv = parseValueText(nrest);
        if (pv.error !== undefined) {
          err(nLineNo, `\`${key}.${nkey}\`:${pv.error}`);
        } else if (pv.value !== undefined) {
          map[nkey] = pv.value;
          result.keyLines[`${key}.${nkey}`] = nLineNo;
        }
        j++;
      }
      if (!consumedAny) {
        err(lineNo, `\`${key}\`:空值不在子集内 —— 请写显式值("" / [] / 一层嵌套映射)`);
      } else {
        result.data[key] = map;
        result.keyLines[key] = lineNo;
      }
      i = j;
      continue;
    }
    const pv = parseValueText(rest);
    if (pv.error !== undefined) {
      err(lineNo, `\`${key}\`:${pv.error}`);
    } else if (pv.value !== undefined) {
      result.data[key] = pv.value;
      result.keyLines[key] = lineNo;
    }
    i++;
  }
  return result;
}
