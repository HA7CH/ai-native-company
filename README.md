# @ha7ch/ai-native-company

> 把你的团队变成 AI native company:一台 Mac mini,一人一个 bot,公司知识全在 markdown 里。
>
> Turn your team into an AI-native company — one Mac mini, one bot per person, all company knowledge in markdown.

**状态:Spec 阶段。** 架构已在一支真实车队生产验证(markdown vault 13+ 周、6-bot 矩阵 8 周,见下),本库是把它抽象成可复制 infra 的立项仓库。详细设计见 [SPEC.md](./SPEC.md),实施计划见 [docs/PLAN.md](./docs/PLAN.md),调研依据见 [docs/RESEARCH.md](./docs/RESEARCH.md)。CLI bin 名为 `anc`(尚未发布)。

---

## 是什么

一个开源 infra:让任何小团队在**一台常开的 Mac mini** 上,快速部署出「公司里每个人都有一个自己的 AI bot」的运行时。

- **一人一 bot,增强而非替代。** bot 对应的是「人」,不是「角色」——两个车队经理就是两个 bot,各自有自己的会话、自己的 skill 迭代轨迹。角色只是 persona 的模板来源。市面上所有「AI 员工」产品都在造新员工替代人头;这里的 bot 是给每个真人配的放大器。
- **bot 住在你们已有的 IM 里。** 飞书、钉钉、企业微信、Slack、Telegram……不用打开新的 dashboard,私聊或群里 @ 就是全部交互。
- **所有 bot 终端同构。** 每个 bot 底下都是同一套东西:官方 coding agent CLI(Claude Code 或 Codex)当 harness(执行引擎)和 token 供给 + 公司共享的 markdown vault(知识库)当数据层。差异只在 persona(bot 的人设:角色模板 × 个人定制)和加载的 skill。
- **公司知识 = 文件系统。** 零 token 设计——指检索路径零额外模型开销:PDF 等原件在入库时**一次性**结构化成 markdown,回答时 bot 用 Read/Grep 直读盘,不做 embedding、不建向量库、不重复解析原件。数据可 git、可审计、可 grep,复杂了再升级 SQLite 索引(markdown 仍是真相源)。
- **越用越 AI native。** 每个人在跟自己 bot 的日常磨合中沉淀 skill——答错一次就长出一个校验 skill,老板连问两次就长出一个规划 skill。系统的能力是用出来的,不是配出来的。

## 为什么可信:已经真实跑着

这套架构不是设想。它以 [Climax Racing 车队](https://climax-racing.com)(2026 GT World Challenge Asia)为 reference deployment 生产运行至今:

- 6 个飞书 bot(车队经理/工程师/后勤/机械师/公关 + devbot)常驻一台 Mac mini
- 数据层是一个结构化 markdown vault(规章/赛程/轮胎/名册),群里发个 PDF,几十秒内自动结构化入库、全 bot 可读
- 10+ 个 skill 全部从真实使用事故和聊天需求里长出来
- 比赛周实测:多角色并发答疑、日报定时推送、四天系统零宕机(期间 1 起数据口径事故,直接催生了 SPEC 的 canonical registry 设计)

reference deployment 仓库含车队真实数据,为私有;M1 起其 generic 部分将陆续抽入本库。

本库做的事,就是把这套生产系统里 **generic 的部分**(三层架构、vault 规范、persona 管线、skill 闭环、运维工具箱)抽出来,变成任何团队 `npx` 一下就能拥有的东西。

## 架构

```
[IM 平台]   飞书 / 钉钉 / 企业微信 / Slack / Telegram / 微信 iLink
     │ 消息 / 文件(免公网 IP 长连接)
     ▼
[Bot 层]    Alice-bot   Bob-bot   Carol-bot   …   devbot(一人一 bot)
            每个 bot = 一个 cwd:persona 文件 + 会话 + 沙箱边界
            persona = 角色模板 × 个人定制,git 真相源渲染进 gateway 配置
     │ 官方 CLI harness(订阅制 token)
     ▼
[Harness]   Claude Code(一等公民)/ Codex CLI(第二后端,可切换)
     │ Read / Grep 直读盘(零 token 设计)
     ▼
[数据层]    公司 vault:结构化 markdown + 目录路由 + git 同步总线
            inbox 自动入库:上传 → 结构化 → commit → 全 bot 可读
```

Gateway 默认基于 [cc-connect](https://github.com/chenhg5/cc-connect)(MIT,Go 单二进制,13+ IM 平台 × 12+ agent 后端)。**本库不写 gateway、不写 agent loop,只做它们之上的编排层**:org 模型 → 配置渲染 → 部署 → 运维 → 迭代闭环。

## Onboarding:安装是一场对话

本体是一个 skill。冷启动不是填配置文件,是聊天:

1. skill 问你「你们公司是做什么的」——语音随便说
2. 要一份人员名单、一批初始资料(PDF、表格、照片都行)
3. 自动生成 vault 结构、每个人的 persona、gateway 配置
4. 引导你走完无法自动化的几步(IM 后台建应用、Claude 登录),装好常驻服务
5. 每个人在 IM 里收到自己的 bot,开始用

```bash
# 目标形态(M2 交付,见 PLAN)
npx @ha7ch/ai-native-company onboard
```

## 和现有方案的区别

| | OpenClaw | Lindy / Dust / 飞书 aily 等 | CrewAI / MetaGPT 等 | **ai-native-company** |
|---|---|---|---|---|
| 部署 | 自托管 ✅ | SaaS 云端 ❌ | 库,自己搭 | 自托管,一台 Mac mini ✅ |
| 组织哲学 | 个人助理 | AI 替代人头 | 模拟虚构公司 | **一人一 bot 增强真人** |
| 公司共享知识库 | ❌ | 托管 RAG | ❌ | **markdown vault,git 可审计** |
| token 供给 | 订阅路径已被切断 * | credit 制,不可预测 | 按量 API | **官方 CLI + 订阅,合规正门** |
| 中国 IM | 二等公民 | 各绑各的云 | ❌ | 飞书生产验证,钉钉/企微同构接入 |

\* Anthropic 2026-04 起封禁第三方自研 agent loop 复用 Claude 订阅;官方 CLI 路径被明确放行——详见 RESEARCH §4。

完整 gap 矩阵(10 个维度 × 13 类方案)见 [docs/RESEARCH.md](./docs/RESEARCH.md)。结论:「自托管 + chat 原生 + 文件系统当数据库 + 一人一 bot 增强真人 + skill 使用者日常迭代 + 订阅制官方 harness」这个组合,目前无人占位。

## Roadmap(摘要)

- **M0** 立项:调研 + SPEC(本仓库现状)
- **M1** 抽取:从 reference deployment 抽出 vault 模板、persona 渲染管线、launchd installer —— `anc init` 能在干净 Mac mini 上拉起「飞书 × Claude Code」的最小公司
- **M2** 对话式 onboarding skill + 资料自动结构化入库 + `anc audit` 安全体检初版
- **M3** 钉钉 / 企业微信 driver + Codex CLI 第二 harness
- **M4** 运维产品化:watchdog、健康探针、token 日报、audit 强化
- **M5** skill 生态:公司内 skill registry、eval 回归

详见 [docs/PLAN.md](./docs/PLAN.md)。

## License

MIT © [HA7CH](https://github.com/HA7CH)
