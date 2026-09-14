# 第二个 reference deployment:制造企业四部门试点的 lessons learned

版本:0.1(2026-09-14)。来源:国内一家医疗器械制造企业的 AI 应用一阶段试点(2026-08 起,研发 / 产品 / 项目 / 采购四部门,由 FDE 团队驻场实施)。本文只写**通用化的机制与裁决**,不写可定位到具体公司、机器、人员的信息;所有 ID 用 `ou_***` / `cli_***` 占位。

Climax Racing 是本库的第一个 reference deployment(车队,6 bot,Mac mini)。本文是第二个,且形态差异很大:**Linux 服务器上的常驻 bot + 全员 Windows 电脑上的个人 agent + 第三方模型**。两个部署互为对照,能分清哪些是 SPEC 的普适裁决、哪些只是第一个部署的局部经验。

---

## 1. 与 SPEC 假设的四处错位

| SPEC 现行假设 | 试点实际 | 结论 |
|---|---|---|
| 托管形态 = Mac mini + launchd(§3.3) | Ubuntu 服务器 + systemd user units;`.path` 单元监听 harness 配置文件变化自动重启 | §3.3 的硬知识是「常驻 GUI 会话 + 凭据 + PATH」三件事,与 OS 无关;installer 需要 launchd / systemd 两个后端 |
| 成员要么已有 Claude Code(light),要么只用 IM bot(PRO) | 全员 Windows、零 agent 起步:一条 PowerShell 离线装 Codex,内网中转站按「姓名-部门」签发 key,导入本地切换器 | 存在第三条路:**企业批量 provisioning**。它不是 light 也不是 PRO,是把 light 的前提「每人已有 agent」制造出来的那一步 |
| Codex 是 M3 才做的第二后端(§3.2) | 第一版 bot 就跑在 Codex CLI 上(Windows 本机,经 cc-connect 飞书长连接);后续版本切到 Claude Code + 第三方 Anthropic 兼容端点 | Codex 路径已有生产实证;双 harness 不是对冲设想,是已经发生的切换 |
| 角色 bot 用中档 Claude 模型,第三方端点只做兜底(§8) | 常态就是第三方模型。Claude Code 自带的 system prompt 身份会压过 `append_system_prompt` 里的 persona,bot 自称 Claude Code、向员工罗列终端能力 | persona 注入在第三方模型下**不可靠**,必须在 API 边界整段替换 system(见 §3.2 补充) |

## 2. 落地后证明通用的机制

### 2.1 对话层与任务层分离

IM 里的 bot 是「始终可用的对话层」;写代码、生成文档、批量处理文件这类要连续用文件工具的工作,不占对话会话,交给独立持久化 worker。生产验证的约定(全部有回归测试锁定):

- **技能库是流程登记表,不是能力白名单**:未命中专项技能但能用通用推理安全完成的事不得拒绝;带外部副作用的操作(部署、外发消息、系统管理)只能经明确配置了受控工具的专项技能执行。
- **对话层有硬性调用预算**:预计超过少量工具调用的请求,先建后台任务再返回,不在主对话里反复尝试;同步回合 timeout ≤ 90 秒,且不设 `--max-turns`(截断会吞掉最终文本)。
- **任务按发送者隔离**:每条消息先按当前发送者查其任务;恰有一个 `waiting_input` 且当前消息是在回答,才续入;明显无关的闲聊不劫持任务、也不擅自结束任务;多个候选先用短编号确认。
- **`needs_review` 不自动重试**:执行器异常中断的任务进入待复核,只有任务所有者明确确认才原子重排队。
- **后台 worker 跑在文件隔离沙箱里**(bubblewrap),只见自己的任务工作区和只读技能库。
- **结果回传有策略层**:普通任务完成后摘要 + 产物发回原会话;敏感类任务(如员工访谈报告)只落服务器内部目录、不回传员工。

### 2.2 会话内规则冻结

SPEC §5 强调 skill「改一次全员即时生效」。多轮工作流(一场访谈跨几天)里这是事故源:规则半途被改,前后半段口径不一致。试点做法:路由策略与线索规格都带 `version` / `approved_by` / `effective_at` / 内容 hash,**每次工作流开始时冻结** `policy_version` 与 `rule_content_hash`,直到该次工作流结束。新规则只对新开的工作流生效。

### 2.3 工作流状态层:SQLite 是真相,markdown 是投影

SPEC §2.3 的裁决(markdown 真相源、SQLite 只做索引)是针对**知识层**的。试点里的**工作流状态层**正相反:会话状态、线索账本、出站消息 outbox 全部在 SQLite 事务里;「完成」状态与「已完成」出站消息**同一事务提交**;常驻 outbox worker 重试未发送消息;个人 JSON、个人 markdown、部门汇总 markdown 都是可重建投影(有 `reproject` 命令)。两条裁决并不矛盾:**知识用文件,状态用事务**。

### 2.4 第三方模型下的两道边界代理

- **system prompt 替换代理**:本机 HTTP 代理拦截 `/v1/messages`,把 `payload.system` 整段替换为应用 persona(工具定义保留在请求里)。根因是 harness 自带的身份提示与 persona 竞争,非 Claude 模型倾向服从前者。
- **工具轮次叙述过滤**:同一代理在响应侧过滤——凡含 `tool_use` 的模型轮次,其 text 块(「让我先查一下技能库」)不回给 IM 用户;只含文本的最终轮次原样透传。cc-connect 的 `display.mode = "quiet"` 关掉的是工具消息,关不掉这类叙述。

两段代码零依赖、各约百行,已泛化进本库 `tools/harness-proxy/`。

### 2.5 卡片交互回调转发

飞书交互卡片(量表、按钮)的回调在 cc-connect 内部消费,无法交给业务进程。试点给 `platform/feishu` 打了一个补丁:按 action 前缀把回调 POST 到本机 HTTP 服务,业务进程返回新卡片或 toast。这是 SPEC §3.1 缺口清单该补的一条,也是一个可上游的 PR(泛化成 `card_action_webhook` 配置项)。

### 2.6 成员个人 agent ↔ 公司 bot 的 A2A

对已经在用 Codex 的软件 / 算法岗,访谈不靠问卷:公司 bot 发一张折叠卡片,里面是给员工本机 Codex 的提示词;员工的 Codex 扫描本机近 N 天的 session,整理出结构化工作摘要,用 `lark-cli` 以**员工本人身份**发回 bot 单聊。协议是一个最小信封(`protocol` / `survey_id` / `message_id` / `reply_to` / `type` / `rule_version` / `payload`),靠 `message_id` 去重、靠 `survey_id` 隔离;`COMPLETE` 只允许服务端完成判定器发出,bot 的对话层无权宣布完成。

这直接回答 #8 里 light 与 PRO 怎么接:**成员自己的 agent 就是公司 bot 的另一个客户端**,通道可以就是 IM 本身。

### 2.7 出站凭据检查

任何 agent → IM 的结构化内容发送前,本机先做确定性凭据扫描(`rg` 正则:app secret / api key / bearer / cookie / 私钥 / 含密码连接串 / 各家 token 前缀),命中即替换后重扫,扫描器不可用则不发。只过滤凭据,不因为内容是代码而过滤。这是 SPEC §7「Model last」的一个具体落点。

### 2.8 A2A 协作规范(人与多智能体共用一个仓库)

试点仓库用三份轻量文件承载多智能体协作:任务看板(ID / 目标 / 主责 / 输入 / 允许修改的文件 / 产出 / 确认人 / 状态)、决策记录(只记影响多个任务或目录的决定)、交接模板(完成了什么 / 改了哪些文件 / 依据 / 验证 / 剩余问题)。三条纪律:**一个文件同一时间只有一个主责**;**原始逐字稿只追加勘误不改写**;**仓库里的「已完成」不等于项目验收**(审批走 IM,回填确认人与日期)。模板已进 `light/skills/anc-onboard/vault-templates/collab/`。

## 3. 诊断期的问题模型:onboarding 不只是建库

第一个部署的 onboarding 是「访谈创始人 → 设计目录 → 建库」,产物是知识结构。第二个部署多了一个前置动作:**先建问题模型,再决定先做哪个 bot、哪个 skill**。

问题模型是对「业务哪里堵了」的结构化描述,五个要素:

| 要素 | 回答的问题 | 试点里的证据来源 |
|---|---|---|
| 核心瓶颈 | 制约业务目标的关键环节是什么 | 决策者访谈;部门负责人确认 |
| 因果链 | 技术原因还是流程原因,外部约束还是内部能力 | 员工级访谈 bot(逐人、逐真实任务) |
| 量化影响 | 损失了什么,能否度量 | 基线采集:任务级人工工时 / 历时 / 返工分开记,量表折算值必须标明不是实测 |
| 相关方地图 | 谁受影响、谁推动、谁阻碍 | 访谈里的情绪信号;高频协作对象 |
| 已有尝试 | 试过什么,为何失败 | 部门已有工具与文档;历史项目记录 |

它与本库架构的结合点:

1. **vault 的诊断层**:`company/problem-model.md` 是 canonical 文件,每个要素带 `状态: 假设 / 已验证 / 已推翻` 与证据链接;它和 `company/team.md` 一样是「易变事实单点存放」的对象。
2. **skill 的种子**:SPEC P6 说 skill 从事故里长出来;诊断期还没有事故,问题模型就是第一批 skill 的立项依据——试点里第一个被产品化的就是「采购周报 → 任务级甘特图 + 阻塞点」,对应的是相关方地图里「管理层看不到任务级进度」这条。
3. **员工级访谈 bot 是问题模型的采集器**:创始人访谈给假设,逐人访谈给证据;bot 的每一轮线索账本对应因果链和量化影响两个要素;访谈报告只记工作事实,**不生成绩效、排名、忙闲或能力评价**(与 SPEC §8「不做个人排名」同一条线)。
4. **F 阶段回头验 C 阶段**:每个里程碑复盘时,先看问题模型哪些「假设」变成了「已验证」或「已推翻」,再谈交付;推翻的要素直接改 vault,不改 persona。

模板见 `light/skills/anc-onboard/vault-templates/company/problem-model.md`;onboarding skill 的访谈已增加对应问题。

## 4. 明确当反模式记录的做法

以下做法在试点里出现过,**不应带进本库**,校验器应当拒绝:

- 员工面向 bot 用 `mode = "yolo"`(等价 bypassPermissions)+ `allow_from = "*"`。SPEC §7 的两条红线没有例外;第三方模型 + 提示注入 + 全权限 = 一条消息就是 RCE。正确做法是 `dontAsk` + allowed_tools 白名单,后台任务进沙箱。
- persona 里写死操作系统绝对路径(Windows 盘符),迁移到 Linux 时靠启动脚本做字符串替换。路径应由渲染管线注入(M1-DESIGN §4.2 的 `vault_root` 机制)。
- 用 IM 的「已读回应」表情做处理中提示。员工面向的访谈 bot 应关掉(`reaction_emoji = "none"`),否则像在监视。

## 5. 对本库的具体改动(本次 PR)

- SPEC:§2.3 状态层裁决、§2.5 问题模型、§3.1 缺口清单 +3、§3.2 Codex 实证与第三方模型边界代理、§3.3 Linux/systemd、§4.3 任务层约定、§5 规则冻结、§6 onboarding 加问题模型阶段、§7 出站凭据检查、§11/§12 风险与开放问题。
- M1-DESIGN:`reset_on_idle_mins` 与 display 段改为角色级可配。
- light/skills/anc-onboard:访谈加问题模型五问;vault-templates(问题模型 + A2A 协作三件套)。
- tools/harness-proxy:system prompt 替换代理 + 工具轮次过滤 + 测试。
- PLAN:登记第二个 reference deployment;M3 增加 provisioning。
