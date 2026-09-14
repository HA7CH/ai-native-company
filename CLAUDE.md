# @ha7ch/ai-native-company — 项目指引

开源 infra 立项库:让小团队在一台 Mac mini 上部署「一人一 AI bot + 公司共享 markdown vault」的运行时。本库是 gateway(cc-connect)与 harness(Claude Code / Codex 官方 CLI)之上的**编排层**——不写 gateway、不写 agent loop。

## 当前状态

- **M0(立项:调研 + SPEC)已完成,当前做 M1**:`anc init` —— 从 reference deployment 抽出 vault 模板、org→config 渲染器、launchd installer,在干净 Mac mini 上拉起「飞书 × Claude Code」最小公司。M1 验收清单见 `docs/PLAN.md`。
- npm 包尚未发布;`package.json` 故意 `"private": true`(防误发空包),M1 有产物后再翻开。CLI bin 名 `anc`。
- GitHub 仓库已 **public**;每个 PR 合并前仍跑「转公开检查」(见下)。

## 文档地图(改代码前先读)

| 文件 | 内容 |
|---|---|
| `SPEC.md` | 架构规范(概念模型、三层架构、persona/skill 系统、onboarding、安全模型、风险登记)——**设计裁决的唯一真相源** |
| `docs/PLAN.md` | M0-M5 里程碑与验收标准 |
| `docs/RESEARCH.md` | 调研公开摘要(gap 矩阵、选型依据) |
| `docs/LESSONS-MANUFACTURING-PILOT.md` | 第二个 reference deployment(制造企业试点)的通用化 lessons:Linux/systemd、批量 provisioning、第三方模型边界代理、对话层/任务层、规则冻结、问题模型 |
| `tools/harness-proxy/` | 第三方模型下的 system prompt 替换 + 工具轮次过滤代理(零依赖,`npm test`) |
| `_research/` | **git-ignored 本地资料**:6 份调研原文(含生产敏感细节)。M1 开工必读清单见 `_research/README-INTERNAL.md` |

## 关键裁决速览(详见 SPEC,不要在实现中偏离)

1. **cc-connect 之上建编排层**,pin 版本;上游缺口(auto-compact、群文件、flag 透传、provider 自动兜底)做进本库约定层 + 逐个上游 PR。
2. **只驱动官方 CLI**(Claude Code 一等公民,Codex 第二后端);绝不提取 OAuth token 给第三方 SDK;鉴权方式是配置项(订阅 OAuth 默认 / API key fallback)。
3. **bot 单位是人不是角色**:两个经理 = 两个 bot;role 只是 persona 模板来源。
4. **每 bot 一个 cwd 四合一**(persona / session scope / 沙箱边界 / 附件落盘);注意 cc-connect 下 `--add-dir` 不透传。
5. **零 token 数据层**:markdown 真相源 + agentic search;复杂了升级 SQLite 索引,真相源永不迁库。
6. 角色 bot **一律不授予 bypassPermissions**;devbot 才有 full。

## 约定

- 文档中文为主;代码 TypeScript,零/极少运行时依赖(ha7ch 工具链习惯)。
- 开发流程:分支 → PR → Codex review → 验证 → squash merge(不直接 push main)。
- reference deployment 是 `~/dev/climax-vault`(本地私有仓库):M1 从它抽 generic 部分,**抽取时必须脱敏**(路径、主机、凭据、人名、赛队专有 schema 都属 specific,不进本库)。第二个 reference deployment(制造企业试点)的代码仓库为客户私有,同样只抽 generic 机制,公司名、内网地址、人名、行业专有口径都不进本库。
- **AGENTS.md 与本文件同步维护**(Codex 镜像,内容一致)。

## 铁律:泄密防线

- `_research/` 与任何含生产细节的内容**绝不 commit**(.gitignore 已排除,别绕过)。
- 转公开检查(repo 转 public 前必跑):`bash scripts/check-public.sh`,零输出且退出码 0 = 通过。规则维护在脚本里(脚本自身不在扫描范围,无自命中;文档示例占位符用 ou_*** / cli_***)。脚本是绊线不是证明,转公开前仍需人工过一遍全量 diff。
- 涉及 reference deployment 的表述只写通用化 lessons learned,不写可定位到具体在跑机器的攻击面线索(措辞用设计约束时态,如「一律不授予」,不用「已整改/待整改」)。
