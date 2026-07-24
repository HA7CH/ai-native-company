# 调研摘要(RESEARCH)

2026-07-24,六路并行调研(2 路内部:reference deployment 仓库解剖 + 生产机实勘;4 路外部:gateway 选型 / OpenClaw 品类 / 组织框架 gap 分析 / IM 平台与 harness 实测)的公开摘要。内部实勘细节不在本文件(涉及生产环境),结论已折叠进 SPEC。

---

## 1. Gap 矩阵:为什么这个组合无人占位

维度:**A** 自托管(单机量级)/ **B** chat 原生 / **C** 中国 IM / **D** 文件系统当数据库 / **E** 一人一 bot 增强真人 / **F** skill 使用者日常迭代 / **G** 订阅制官方 harness / **H** 公司级共享真相源 / **I** 资料自动结构化入库 / **J** 开源

| 方案 | A | B | C | D | E | F | G | H | I | J |
|---|---|---|---|---|---|---|---|---|---|---|
| MetaGPT / ChatDev | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| CrewAI / LangGraph / MS Agent Framework / OpenAI Agents SDK | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Claude Agent SDK | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | 部分 |
| Lindy / Relevance / Sintra / Marblism | ❌ | ⚠️ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ |
| Dust | ❌ | ⚠️ | ❌ | ❌ | ❌ | ⚠️ | ❌ | ⚠️ | ⚠️ | ❌ |
| Sierra | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ❌ |
| 钉钉 AI 助理 / 飞书 aily / 腾讯元器 | ⚠️ | ✅ | ✅ | ❌ | ⚠️ | ⚠️ | ❌ | ⚠️ | ⚠️ | ❌ |
| Coze Studio | ✅ | ✅ | ✅ | ❌ | ❌ | ⚠️ | ❌ | ❌ | ⚠️ | ✅ |
| OpenClaw | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌* | ❌ | ❌ | ✅ |
| OneManCompany | ✅ | ❌ | ❌ | ⚠️ | ❌ | ⚠️ | ✅ | ⚠️ | ❌ | ✅ |
| Claude Cowork / Managed Agents | ⚠️ | ❌ | ❌ | ✅ | ⚠️ | ⚠️ | ✅ | ❌ | ❌ | ❌ |
| Microsoft Agent 365 | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ⚠️ | ⚠️ | ❌ |
| Every Plus Ones | ❌ | ✅ | ❌ | ❌ | ⚠️ | ✅ | ❌ | ❌ | ❌ | ❌ |
| WorkBuddy(腾讯,2026-03)* | ⚠️ | ✅ | ✅ | ❌ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ | ❌ |
| **ai-native-company(目标)** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

\* OpenClaw 的订阅路径 2026-04 被 Anthropic 切断(见 §4)。
\* WorkBuddy:腾讯桌面 AI agent 工作台(OpenClaw-like),2026-03 上线 90 天国内第一、5 月出海;任务式多 agent 调度(非一人一持续 bot)、积分制计费、知识层为本地文件+连接器(无公司共享真相源)——验证了 messaging-first 的量级,E/H 两列仍空。

**关键观察:E(一人一 bot 对应真人、增强而非替代)和 H(公司级共享 vault)两列,矩阵里没有任何一家打勾。** 所有「AI 员工」产品在造新员工替代人头;所有框架不建组织数据层。单维度倒是多数已被市场验证是对的:A 被 OpenClaw 验证(甚至带火 Mac mini 销量,Bloomberg 2026-05 报道)、C 被飞书官方下场给 OpenClaw 写插件验证、D 被 Anthropic 自己弃向量改 grep 验证、F 被 Every 的 compound engineering 验证、G 被两家厂商把 agent 用量塞进订阅验证。

## 2. Gateway 选型:cc-connect 之上,不 fork、不自研

- **cc-connect**(github.com/chenhg5/cc-connect,MIT,Go 单二进制):5 个月 14.3k stars、143 contributors、周更 beta;13+ IM 平台(国内全家桶 + Telegram/Slack/Discord/Matrix)× 12+ agent 后端(claudecode/codex/opencode/gemini/ACP 自定义)。`[[projects]]` 配置模型(每 project = 独立 persona + work_dir + agent + 平台凭据)与「一人一 bot」一一同构。
- 判断:**(a) 构建其上**。13 平台 × 12 agent 的 adapter 矩阵是全部维护成本所在,143 人在替你扛平台 API churn;fork 即失去这些。已知缺口(无 auto-compact #1111、群文件不落盘 #1560、launchd+OAuth #752、多 bot 单 WS 丢消息 #1562)恰好应该做进本库约定层,同时逐个上游 PR。
- 同类竞品全是单平台或个人向:lark-coding-agent-bridge(2k)、botmux、open-cowork(桌面 App 路线)、Claude Code Channels(Anthropic 官方,仅 Telegram/Discord,不碰中国 IM)。
- 作者自己的组织编排实验 agencycli(145 stars)是概念最近邻,但 **AGPL,只可参考设计不可引代码**。

## 3. OpenClaw:品类定义者与教科书级反面教材

- ~384k stars,史上增速最快开源项目;证明「自托管 agent + 住在 IM 里 + Mac mini」的需求量级。设计单元是**个人助理**:无用户体系、无角色权限、无共享数据层、无组织生命周期(联合国大学 C3 为组织部署被迫在外面包 SSO/隔离/93 条安全测试——那份清单就是「组织层」的需求说明书)。
- **值得直接抄**:bindings 声明式路由((channel, account, peer, roles) → agent,特异性分层);markdown 记忆两层制(MEMORY.md 精选 + 日期 append-only + SQLite 只做索引);HEARTBEAT.md + 无事静默 + 每跳 fresh session;`onboard` 向导与 `security audit --fix` 成对出现;SKILL.md 跨 harness 同格式。
- **引以为戒**:默认 0.0.0.0 无鉴权 → 首日扫出 4 万公网裸奔实例、1.28 万可 RCE、两个高危 CVE(默认值即安全策略);ClawHub skill 市场 12% 恶意率、借 SKILL.md 发木马(供应链);提示注入实测成功率 >79%,无模型级解(Identity first / Scope next / Model last 三层防线);自研 agent loop 蹭订阅 → Anthropic 2026-01 禁第三方 OAuth、04-04 彻底切断(合规红线);Clawdbot 四天两次改名引发假币钓鱼(命名先做尽调)。

## 4. Harness:官方 CLI 是唯一合规正门,双后端可行

- **Anthropic 政策线**:禁止 Claude Pro/Max OAuth token 用于第三方工具,但明确放行 claude CLI / `claude -p` 路径;原定 2026-06-15 的 Agent SDK 独立 credit 池方案已官宣暂停(目前 headless 仍直接消耗订阅额度)。**计费模式必须当作会变的外部条件设计**(API key fallback + per-member credential)。
- **Codex CLI**(实测 0.144.1):`exec` + `--json`(条目级事件,无 token delta)+ `exec resume`(cwd-scoped);persona 注入用 cwd 的 AGENTS.md + `-c developer_instructions`;默认只读沙箱。ChatGPT 订阅与 web/IDE 共享 5h 窗口 + 周限额。
- **Claude Code**(实测 2.1.207+):`--input-format stream-json` 双向常驻(token 级流式 + 原生 auto-compact);`--resume` cwd-scoped;`--append-system-prompt(-file)`;注意 `--bare` 跳过 OAuth(订阅供 token 不能开)。
- **统一抽象的枢轴是「每 bot 一个 cwd」**:persona 文件(CLAUDE.md/AGENTS.md)、session scope、沙箱边界、附件落盘四合一,两个 harness 语义完全一致。最小公共接口 = 回合制 runTurn + 事件流(message/result 保底,delta 是 Claude 增强)。

## 5. IM 平台矩阵(要点)

- **国内三大平台(飞书 / 钉钉 Stream Mode / 企微智能机器人)全部提供免公网 IP 的 WebSocket 长连接**,与「一台 Mac mini、无反代」完美契合;三家都原生支持卡片流式打字机。
- 企业微信是 2025-26 的新开放面:长连接免加解密、全媒体、流式,官方正对 10 人以下小团队开放,窗口期红利。
- **微信 iLink**:2026-03 腾讯官方开放的个人微信 Bot API(有服务条款,非灰产),但仅单聊、无群发、token 过期要重扫码、禁营销——只适合 experimental 个人通道,不做公司主通道。
- Slack 2025 起对非 Marketplace 应用重限流,但**企业自建 internal app 豁免**——「每公司自建 app」模式正好落在豁免区。
- 入站 transport 只有三类:WS 长连接 / webhook / 长轮询。gateway 抽象按此三类即可覆盖全部平台。

## 6. 「文件系统当数据库」的行业背书

Anthropic 2025-05 从 Claude Code 移除向量检索改用 agentic search(Boris Cherny:「更简单,且没有安全/隐私/staleness/可靠性问题」),Cursor/Windsurf/Cline/Devin/Amp 全部跟进弃向量。markdown vault + 预结构化 + agentic search 站在行业趋势正确一侧,并免费获得三个副产品:git 版本控制、人可读审计、跨 harness 可移植。

## 7. 理念背书与竞争时钟

- 理念供给过剩(WAIC 2026「AI-Native Organizations」议题、Deloitte「The Great Rebuild」、Every 的 allocation economy / compound engineering),但「小团队今天想变 AI-native 该 git clone 什么」没有答案——理念与 infra 之间的缝就是本项目。
- 时钟:WorkBuddy 90 天做到国内第一并出海(messaging-first 需求量级的最强实证,企业版 198 元/人/月);Claude Cowork 2026-07 起向 web/移动/企业扩张;Dust 拿 Sequoia B 轮;钉钉/飞书国内加速;OpenClaw 社区随时可能把团队化用法产品化。窗口存在,但不会永远开着。

---

*完整调研原文(含全部来源 URL)存档于内部;本摘要保留了所有影响架构裁决的事实。*
