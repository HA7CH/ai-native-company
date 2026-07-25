#!/usr/bin/env node
/**
 * anc —— AI native company 编排层 CLI(M1-DESIGN §6)。
 *
 * W1 只落地命令分发骨架:各命令按 M1 排期(§11)在 W2/W3 落地。
 * 全局约定:退出码 0 成功 / 1 校验或诊断失败 / 2 用法错误 / 3 已应用但探针失败且已自动回滚;
 * --json 全命令支持;错误恒为两行:ERROR + FIX。
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface CommandStub {
  week: "W2" | "W3";
  summary: string;
}

const COMMANDS: Record<string, CommandStub> = {
  init: { week: "W3", summary: "生成 vault 骨架 + ~/.anc 初始化 + SETUP-CHECKLIST.md" },
  deploy: { week: "W2", summary: "config|personas|skills:org 真相源 → 线上(dry-run 默认)" },
  status: { week: "W3", summary: "launchd/探针/同步/漂移 一屏状态(--usage / --probe)" },
  doctor: { week: "W3", summary: "环境诊断清单(GUI 会话/keychain/PATH/版本 pin)" },
  rollback: { week: "W3", summary: "列备份 → 恢复 → kickstart → 探针(一键急救)" },
  selftest: { week: "W2", summary: "--sandbox:本机沙箱真跑 launchd 全链(发版用)" },
};

function readVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function usage(): string {
  const lines = [
    "anc —— 一台 Mac mini,一人一 bot,公司知识全在 markdown 里(M1 开发中)",
    "",
    "用法:anc <命令> [选项]    全局选项:--json",
    "",
    "命令(SPEC §9 / docs/M1-DESIGN.md §6):",
  ];
  for (const [name, stub] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(10)}${stub.summary}(${stub.week} 实现)`);
  }
  lines.push("");
  lines.push("退出码:0 成功 / 1 校验或诊断失败 / 2 用法错误 / 3 已应用但探针失败且已自动回滚");
  return lines.join("\n");
}

export function main(argv: string[]): number {
  const args = argv.filter((a) => a !== "--json");
  const json = argv.includes("--json");
  const cmd = args[0];

  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    if (json) {
      process.stdout.write(`${JSON.stringify({ commands: Object.keys(COMMANDS), version: readVersion() })}\n`);
    } else {
      process.stdout.write(`${usage()}\n`);
    }
    return 0;
  }
  if (cmd === "--version" || cmd === "-V" || cmd === "version") {
    process.stdout.write(json ? `${JSON.stringify({ version: readVersion() })}\n` : `${readVersion()}\n`);
    return 0;
  }

  const stub = COMMANDS[cmd];
  if (!stub) {
    const error = `未知命令 \`${cmd}\``;
    const fix = "运行 anc --help 查看命令清单";
    process.stderr.write(json ? `${JSON.stringify({ error, fix, exit_code: 2 })}\n` : `ERROR: ${error}\nFIX: ${fix}\n`);
    return 2;
  }

  const error = `\`anc ${cmd}\` 尚未实现 —— 按 M1 排期在 ${stub.week} 交付(docs/M1-DESIGN.md §11)`;
  const fix = "W1 已交付 org schema + 渲染器 + 三重校验(库形态);命令面见后续 PR";
  process.stderr.write(json ? `${JSON.stringify({ error, fix, exit_code: 1 })}\n` : `ERROR: ${error}\nFIX: ${fix}\n`);
  return 1;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
