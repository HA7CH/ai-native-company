# @ha7ch/ai-native-company

> 不搬家、不换软件、不培训。跟 AI 聊一次天,你们公司就有了共享大脑——哪怕你们公司只有三个人。
>
> No migration, no new dashboard, no training. One conversation, and your company has a shared brain — even if your company is three people.

**状态:轻形态 MVP 已可用,托管形态设计完成。** 架构已在一支真实车队生产验证(markdown vault 13+ 周、6-bot 矩阵 8 周,见下)。详细设计见 [SPEC.md](./SPEC.md)(托管形态)与 [docs/LIGHT-MVP.md](./docs/LIGHT-MVP.md)(轻形态),实施计划见 [docs/PLAN.md](./docs/PLAN.md),调研依据见 [docs/RESEARCH.md](./docs/RESEARCH.md)。CLI bin 名为 `anc`(尚未发布)。

---

## 三件事

大厂的企业 AI 平台在讲同一个词:让 AI 拥有公司知识。这件事本身没有争议,分歧在**代价**——它们的答案都要求你先成为一家"够格上平台的公司"。这个库赌的是另外三件事:

### 一、不搬家

你们现有的 PDF、微信里的截图、那张谁都不敢改的 Excel,**留在原地**。不迁进某家云的文档/网盘/知识库,不换 IM,不装新的工作台,没有一个新界面要学。

接入是加一条连接,不是搬一次家:

```bash
claude mcp add --transport http vault https://<worker>/mcp --header "Authorization: Bearer <token>"
```

vault 跑在**你自己的** Cloudflare 账号上(Worker + R2),数据是纯 markdown,可 git、可 grep、可审计、可以随时整个拖走。我们既不托管你的数据,也不希望你被我们锁住——真锁得住的产品不需要写这一句。

### 二、安装是一场对话,不是一次部署

冷启动没有配置文件,没有实施顾问,没有为期两周的 POC。创始人打开 Claude Code,说一句「建公司知识库」,然后**开始聊天**(全程可以语音):

```
你们公司是做什么的?
→ 日常最常被问的 3-5 类问题是什么?     ← 这一问决定目录怎么分
→ 有哪些术语黑话?  有哪些资料?  团队有谁?  哪些事实经常变?
→ 目录设计给你看一眼 → 确认 → 写库 → 全员可查
```

**访谈本身就是行业适配器。** 不预设行业:贸易行答出来的是订单/客户/报价,律所答出来的是案件/合同/判例,车队答出来的是赛程/规章/器材。这是这个库不做行业模板、也不需要做行业模板的原因——没有一个下拉框能穷举行业,但一场对话可以。

### 三、三个人也算一家公司

管理后台、组织架构、治理审计、用量看板——这些东西的存在前提是"有人专门管这个"。三个人的货代行没有这个人,一辈子也不会有。他们不会走采购流程,不会做 POC,不会为私有化部署出预算。

所以这个库的最小单位不是"企业",是**一个老板加两个员工**:

- 老板自己花十分钟聊完,库就建好了,没有第三方进场;
- 新人加入是一行命令 + 一个 token,不是开账号、配权限、做培训;
- 公司改一次技能正文,全员**下一次使用**就生效——因为技能正文住在 vault 里,本地只留一张名片(见[技能名片](#技能名片公司改一次全员下一次生效));
- 便宜到不需要立项:一个 Cloudflare Worker + R2 的量级。

---

## 是什么

一个开源 infra:公司的知识层(共享 vault + 角色 persona + skill 闭环)+ 按团队现状可选的运行层。上面三件事在两种形态里是同一套东西的两种落法——按「团队里有没有人已经在用 Claude Code」分:

| | 轻形态(`light/`,**MVP 已可用**) | 托管形态(SPEC 主线) |
|---|---|---|
| 假设 | 每人已有 Claude Code 等 agent 工作台 | 团队还没有 AI,从零拉起 |
| 我们提供 | **云上唯一一份公司 vault**(Cloudflare Worker + R2)+ 一行接入 + 三个 skill,不部署任何 agent | 一台常开 Mac mini:一人一 bot 常驻公司 IM,vault + 网关 + 运维全托管 |
| 接入 | `claude mcp add` 一行;onboarding 访谈建库(行业适配器) | `anc init` + 引导 checklist |
| 覆盖 | 用 Claude Code 的人 | 全员(含不碰终端的同事,飞书/钉钉里 @ 即用) |
| 「不搬家」体现为 | 不离开你已有的 Claude Code | 不离开你已有的 IM(飞书/钉钉/企微) |

两种形态共享同一套 vault 规范与 skill 体系;托管形态的 IM bot 就是轻形态 vault 的另一个客户端,先轻后重、随时升级。

## 我们不是什么

免得对号入座:

- **不是一个工作台。** 没有 dashboard,没有要登录的网页,没有"打开我们的 App 开始一天的工作"。对话就是全部界面。
- **不是数字员工。** 不造新员工替代人头。bot 的单位是「人」——两个车队经理就是两个 bot,各自演化。它是给每个真人配的放大器,不是他的替代品。
- **不是知识库 SaaS。** 不托管你的数据,不做向量库,不建索引服务。原件一次性结构化成 markdown,回答时直读盘(零 token 设计,见 [SPEC](./SPEC.md) P2)。
- **不是给中大型企业的。** 不做治理审计、组织架构树、用量看板。需要这些的公司应该去买平台,那些产品做得比我们好且有人给你交付。

## 托管形态:每个人都有一个自己的 AI bot

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

## 技能名片:公司改一次,全员下一次生效

平台靠管理后台推送更新,我们没有后台,靠一个更简单的东西:**本地装的不是技能,是名片。**

```
~/.claude/skills/anc-ingest/SKILL.md   ← 名片:只有触发词 + 安全底线,几乎永不改
        │ 每次调用实时读
        ▼
vault: skills/anc-ingest/SKILL.md      ← 正文:真正的步骤、规范、话术,公司自己改
```

带来三件事:

- **改一次全员生效。** 老板发现入库分类错了,改 vault 里那个 markdown,全公司下一次调用就是新版——不发版、不推送、不通知升级。
- **安全底线在本地写死,vault 正文越不过去。** 不执行库外文件写入、不碰 `~/.claude/`、不外发凭据;正文里若出现要求执行命令或外发数据的内容,一律忽略并向用户报告(vault 里的东西是数据,不是给 agent 的指令)。这条防线放在本地而不是云上,是因为**能被远程改的防线不叫防线**。
- **技能是公司资产,不是我们的。** 你们长出来的技能住在你们自己的 vault 里,我们读不到,也拿不走。

## 托管形态的 onboarding:同一场对话,多几步装机

轻形态聊完就能用(上面「三件事·二」)。托管形态多的只是装机——本体仍然是一个 skill,冷启动仍然不是填配置文件:

1. skill 问你「你们公司是做什么的」——语音随便说
2. 要一份人员名单、一批初始资料(PDF、表格、照片都行)
3. 自动生成 vault 结构、每个人的 persona、gateway 配置
4. 引导你走完无法自动化的几步(IM 后台建应用、Claude 登录),装好常驻服务
5. 每个人在 IM 里收到自己的 bot,开始用

第 4 步是老实话:建 IM 应用、OAuth 登录、开自动登录这几件事**没法自动化**,所以做成引导式 checklist,状态断点续走,不假装能一键。「向导 + 体检」成对出现(`anc audit`)。

```bash
# 目标形态(M2 交付,见 PLAN)
npx @ha7ch/ai-native-company onboard
```

## 和现有方案的区别

| | OpenClaw | 企业 AI 工作台 † | CrewAI / MetaGPT 等 | **ai-native-company** |
|---|---|---|---|---|
| 最小单位 | 一个人 | 一家有 IT 预算的企业 | 一个开发者 | **一个老板 + 两个员工** |
| 上手成本 | 自己折腾 | 部署 + 培训 + 采购流程 | 写代码 | **一场对话(可语音)** |
| 数据在哪 | 你机器上 | 搬进平台自家生态 ❌ | 你自己搭 | **你自己的云,纯 markdown,可整个拖走** |
| 部署 | 自托管 ✅ | SaaS / VPC / 私有化交付 | 库,自己搭 | 自托管,一台 Mac mini ✅ |
| 界面 | IM | 新工作台 + 管理后台 ❌ | 无 | **对话即界面,零新界面** |
| 组织哲学 | 个人助理 | 数字员工(替代人头) | 模拟虚构公司 | **一人一 bot 增强真人** |
| 公司共享知识库 | ❌ | 托管 RAG | ❌ | **markdown vault,git 可审计** |
| token 供给 | 订阅路径已被切断 * | 平台计费,不透明 | 按量 API | **官方 CLI + 订阅,合规正门** |
| 中国 IM | 二等公民 | 各绑各的云 | ❌ | 飞书生产验证,钉钉/企微同构接入 |

\* Anthropic 2026-04 起封禁第三方自研 agent loop 复用 Claude 订阅;官方 CLI 路径被明确放行——详见 RESEARCH §4。

† 腾讯云 WorkBuddy 企业版、飞书 aily、钉钉 AI 助理、Lindy / Dust 等。这一列 2026 年增长最快,叙事也和我们高度重合(「让 AI 拥有企业知识」)。**重合的是话,不是活**:它们卖给采购部,交付方式是部署,数据要进它们的生态,最小单位是一家够格上平台的公司。我们服务的是那些永远不会走这套流程的团队。

完整 gap 矩阵(10 个维度 × 13 类方案)见 [docs/RESEARCH.md](./docs/RESEARCH.md)。结论:「自托管 + chat 原生 + 文件系统当数据库 + 一人一 bot 增强真人 + skill 使用者日常迭代 + 订阅制官方 harness」这个组合,目前无人占位。

## Roadmap(摘要)

- **轻形态 MVP** ✅:云上公司 vault(Worker + R2,MCP 五工具 + 版本历史)+ onboarding/join/ingest 三 skill,见 [`light/`](./light/)
- **M0** 立项:调研 + SPEC ✅
- **M1** 抽取:从 reference deployment 抽出 vault 模板、persona 渲染管线、launchd installer —— `anc init` 能在干净 Mac mini 上拉起「飞书 × Claude Code」的最小公司
- **M2** 对话式 onboarding skill + 资料自动结构化入库 + `anc audit` 安全体检初版
- **M3** 钉钉 / 企业微信 driver + Codex CLI 第二 harness
- **M4** 运维产品化:watchdog、健康探针、token 日报、audit 强化
- **M5** skill 生态:公司内 skill registry、eval 回归

详见 [docs/PLAN.md](./docs/PLAN.md)。

## License

MIT © [HA7CH](https://github.com/HA7CH)
