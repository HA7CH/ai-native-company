# anc init：飞书 × Codex 初始化设计

版本：0.1，2026-11-23。状态：开发版已实现；初始化、诊断、预览、部署与恢复通过自动化及本机集成验证。干净机器和专用飞书应用的完整新装验收仍待完成。

承接 [M1-DESIGN.md](./M1-DESIGN.md) §3、§6、§8，聚焦 `anc init` 的可实现契约。用户已选择先交付 macOS 上的「飞书 × Codex」托管形态；不依赖轻形态、Cloudflare 或 Claude Code。

本文列出相对于旧 M1 设计的调整；当前实现裁决已同步到 [SPEC.md](../SPEC.md)，避免形成第二个规范真相源。原 M1 的完整验收范围仍保留，不以初始化成功代替上线验收。

## 1. init 的完成标准

一句话：**把一个空目录变成有结构、有成员定义、能继续配置和部署的公司 vault，并明确告诉用户还差什么。**

`init` 完成意味着文件初始化成功，不意味着飞书已连接。缺少 CLI、登录、飞书应用凭据或远端仓库，不阻止生成骨架；这些条件由后续 `doctor` 和 `deploy` 分别检查。

| 步骤 | 命令职责 | 成功依据 |
|---|---|---|
| 初始化 | `anc init` | vault、主机状态和初始化清单完整 |
| 配置 | 用户补成员绑定、在本机填写 secret | 字段合法，凭据存在；不要求手写 gateway config |
| 检查 | `anc doctor` | 部署依赖与配置通过；未安装服务记未部署，不混同故障 |
| 预览 | `anc deploy config` | 展示完整变更计划与阻断项，默认不应用 |
| 上线 | `anc deploy config --apply` | 配置、persona、plist 同批应用，平台就绪；失败可恢复 |
| 验收 | `anc status` + 真人飞书测试 | 当前进程健康，真实消息能够读库并回传 |

`init` 不启动网关、不下载 CLI、不登录、不创建飞书应用、不发送消息、不配置自动登录、不上传资料。业务访谈、自动入库和批量建人成为独立后续能力。

## 2. 命令和交互契约

以下命令通过源码构建使用；npm 包仍为 private，尚未发布。

```bash
# 有终端时询问公司名称、稳定 ID、第一位使用者 ID/称呼
anc init --dir ./demo-vault

# 可重复执行的非交互入口：不传任何 secret
anc init --dir ./demo-vault --company-name "示例公司" \
  --company-id demo --member-id alice --member-name "Alice" \
  --harness codex --platform feishu --non-interactive

# 只查看文件创建计划；不创建目录、锁、Git 仓库或主机状态
anc init --dir ./demo-vault --company-name "示例公司" \
  --company-id demo --member-id alice --member-name "Alice" \
  --dry-run --non-interactive --json
```

首版默认 `harness=codex`、`platform=feishu`；其他值明确报尚未支持，不能静默回落。默认语言 `zh-CN`、时区 `Asia/Shanghai`，交互摘要展示这两个默认值；通过 `--language`、`--timezone` 可覆盖。

- `--dir` 缺省为 `./<company-id>-vault`；无参数时不能向当前非空工程目录直接铺模板。
- 公司/成员 ID 使用小写 ASCII 字母开头，后续仅小写字母、数字、连字符，最长 32 字符；显示名支持中文。secret 环境变量名由 ID 大写并将连字符转为下划线确定性生成。
- 首版明确收集第一位真人，不再以「成员概数」生成虚构人员。其他人员之后编辑 `members/` 加入。
- 参数和交互冲突时，以明确参数为准；非交互缺必填参数、无 TTY 却缺参数时退出 2，不能悬停等输入。
- `--json` 隐含非交互，stdout 仅一个结果对象；诊断在 stderr，绝不包含 secret。
- 首版不提供 `--force`。覆盖现有用户文件属于升级/接管，不能靠初始化开关绕过。

重复运行时，从已完成的 manifest 和 org 恢复身份字段；显式参数与它们冲突就报错。公司/成员改名不是重跑 init 的隐含副作用。

## 3. 两类产物和数据边界

### 3.1 可进入公司私有 Git 的 vault

```text
demo-vault/
├── .gitignore
├── .anc-init.json            # 初始化归属 ID，无主机路径或凭据
├── AGENTS.md                 # 五段根路由
├── CLAUDE.md                 # 同源生成，与根 AGENTS.md 一致
├── CONTRIBUTING.md
├── company/company.md        # 公司身份、harness、默认策略
├── company/profile.md        # 待补业务简介，不编造经营事实
├── roles/manager/persona.md
├── roles/devbot/persona.md    # 模板，默认没有启用它的成员
├── members/alice/persona.md   # 第一位真人，待补飞书绑定
├── knowledge/AGENTS.md
├── knowledge/CLAUDE.md
├── knowledge/_originals/.gitkeep
├── templates/record.md       # title/source_file/updated 规范
├── skills/README.md          # 技能规范，不假装已有四个通用技能实现
├── docs/SETUP-CHECKLIST.md
└── docs/RUNBOOK.md
```

不向新公司的知识库写入真实 reference deployment 内容。示例只放在 `templates/`，不能让 bot 把演示数据当公司事实。首版 init 不预置自动外发技能。

### 3.2 本机私有目录

```text
~/.anc/                      # 700；v1 仍是一机一公司
├── host.json                # schemaVersion、companyId、vaultRoot、harness
├── init-manifest.json       # 模板版本、归属文件 hash、事务状态
├── secrets.env              # 600；仅键名和空值，不覆盖旧值
├── credentials/             # deploy 生成的私有凭据版本，600；用于匹配配置回滚
├── runtime.json             # CLI/登录目录/代理和凭据版本引用，无密钥明文
├── homes/alice/
│   └── attachments/
├── bin/
├── logs/
└── backups/
```

主机路径、CLI 路径、版本/构建校验值、gateway label/data_dir 等只进入主机层；未探测到的二进制记 `null` 和待办，不写猜测路径。`host.json` 不持有 OAuth token。

首次 init 创建空的 `ANC_FEISHU_SECRET_ALICE` 项。后续 deploy 严格解析 `secrets.env` 的受限键值格式并注入子进程，不把该文件当 shell 脚本 `source`，不执行变量展开或命令替换。原 M1 的 source 方案应随这一裁决更新。

deploy 为当前启用成员创建不可变的私有凭据版本，runtime 只引用版本路径。轮换密钥会触发部署；失败恢复时旧配置与旧凭据配对，不覆盖用户正在编辑的 secrets.env。版本保留在主机状态目录用于回滚，不进入 vault、公开日志或普通配置备份；撤销凭据后应按公司的留存策略清理不再需要的版本。调用者的 `CODEX_HOME` 同步固化到运行配置，保证 doctor 与 launchd 使用同一官方登录目录。

`init` 可以在新 vault 执行 `git init`，不自动 commit、建 GitHub 仓库、配置 remote 或 push；缺少 Git 时保留已生成文件，输出待办，初始化本身仍成功。远端同步是明确的配置项，没有 origin 时不安装一个注定失败的定时 pull。

## 4. org 与 Codex 的最小配置

沿用 markdown + frontmatter；增加 `schema_version: 1` 和公司级 `harness: codex`。第一阶段是一家公司一个后端，不做成员混合后端。

```yaml
# company/company.md 的 frontmatter
schema_version: 1
name: 示例公司
id: demo
language: zh-CN
timezone: Asia/Shanghai
platform: feishu
harness: codex
defaults:
  policy: readonly
  model: ""
admins: []
sync_enabled: false
```

角色定义采用 `policy: readonly|workspace|full` 表达权限意图；不再让 org 的通用字段直接存 Claude 专有 `dontAsk`。字段兼容/迁移由 schema 版本控制，不猜测旧档位等价关系。

| org 意图 | Codex 适配器候选映射 | 部署要求 |
|---|---|---|
| `readonly` | cc-connect `suggest` | 在固定 gateway/CLI 组合上验证实际只读行为 |
| `workspace` | `auto-edit` | 验证首次和 resume 都只允许批准工作区内写入 |
| `full` | 首版不生成 | 不得将 devbot 模板的存在理解为启用无限制执行 |

以上是需要契约测试锁定的映射，不能仅凭模式名称或 example 注释判断有效沙箱。`vault_scope` 只是路由和职责声明，**不是文件系统访问控制**；若有效策略不能满足 SPEC 的数据视野约束，部署须阻断并补隔离方案，不能用 persona 承诺替代。

第一位成员生成 `role: manager`、`disabled: false`、空的 `feishu.app_id/open_id`，初始化校验允许这些明确待填项，部署校验必须拒绝。默认管理员为空，不自动把创始人加入每个成员的聊天白名单；管理员命令授权和可对话者是两种权限。

模型为空表示使用官方 CLI 默认模型；显式 model 由 org 传入。适配器隔离用户配置、MCP、hooks 和 permission rules，仅复用官方 CLI 登录，不提取 token。doctor/probe 验证实际可用，不把某个易变模型名写进永久模板。

成员 cwd 包含 `.anc-bot-root` 作为指令发现边界，避免加载父目录的 AGENTS。系统 scratch 目录可能由 Codex 授予基础访问，因此真实部署拒绝把 vault 或主机状态放入系统临时区；测试隔离目录可以用于 init 和预览。

Codex persona 从 company × role × member 渲染到 `~/.anc/homes/<member>/AGENTS.md`，只保留一条注入路径。初始化时建立目录；在 deploy 时与 config 一起生成、校验和事务应用。根 vault 的 AGENTS/CLAUDE 双文件用于知识路由，不能再将成员 persona 同时塞进 gateway prompt。

Codex 的 skills 暂不复制到用户全局 `~/.claude/skills/`；后续按成员工作目录的 `.agents/skills/` 部署，并测试当前 CLI 的发现语义。不得把原文的 headless Claude `/cost` 当作 Codex 用量接口。

### 必须同步的设计调整

| 旧约定 | 本草案提案 | 同步位置 |
|---|---|---|
| Codex 留 M3 | 提前交付 Codex + 飞书的一条完整链路 | SPEC §3.2、PLAN M1/M3、项目双指引 |
| 所有 gateway persona 内联 | Codex 使用成员 cwd/AGENTS.md，Claude 原路径保留 | SPEC §2.2、§4.2、M1 §4/§9 |
| 全公司恰好一个启用 devbot | 模板保留，先允许一个普通成员完成最小公司；devbot 至多一个、显式启用 | SPEC §2、M1 §3.3/§4.4 |
| init `--force` 覆盖 | init 永不覆盖用户变更；升级和接管另行计划 | M1 §6 |
| init 后固定装三件套 | gateway 必需；sync 依 remote 配置启用；watchdog 不以空闲日志判死 | M1 §5/§10 |

上述差异已由 SPEC 的当前实现裁决承接。尤其「先不启用 devbot」不改变「普通角色不得 full」的铁律。

## 5. 重跑、中断和冲突

不能仅以「文件已存在就跳过」证明幂等，否则第二次用另一个公司 ID 重跑也会被误报成功。

1. **先计划**：规范化目标路径；拒绝目标根/受管目录符号链接、目录穿越和文件类型冲突。检查 vault 与 host 的绑定关系。对已有父目录解析真实路径并展示实际目标。
2. **明确所有权**：空目录可新建；完整 manifest 指向同一 vault 才可续跑；非空且不归 anc 管理的目录返回 `EXISTING_UNMANAGED_VAULT`，不注入模板。已有 `~/.anc` 绑定其他 vault 时退出，不悄悄实现多公司。
3. **预览和锁定**：dry-run 只产生计划；正式执行使用排他锁，记录进程与事务标识。锁失效需核实进程不再存在；不能仅凭经过多久就抢锁。首版提供明确的手工清锁指引，不自动删除可能刚被另一进程替换的锁。vault 与主机状态各自加锁，归属 ID 防止两个状态目录同时认领同一个 vault。
4. **先写恢复记录**：落盘事务日志，记录预期 companyId、vaultRoot、模板版本和本次拟创建文件，写入前确保目录权限正确。中断后用它识别未完成初始化。
5. **逐文件提交**：同目录临时文件、fsync、采用不会替换既有目标的提交方式；manifest 记录成功项和 hash。遇到并发出现的文件视为冲突，不覆盖。
6. **重跑分类**：不存在→创建；内容与生成 hash 相同→跳过；用户改动→保留并报告；文件/目录类型不符→退出 1。公司 ID、主机绑定等关键身份冲突必须阻断。
7. **完成检查**：必要目录、路由双文件、org 草稿和权限检查通过后标记 initialized。摘要列出 created/skipped/preserved、待办和下一步命令。

vault 与 `~/.anc` 可能位于不同卷，不能承诺跨目录原子事务。承诺是**任何中断可识别、可续跑，失败不会启动服务或覆盖用户资料**。重复执行不更新旧 secrets、不重设 Git remote、不变更运行中的 gateway。

部分初始化下目录非空但事务日志已匹配，应允许续跑；没有日志的陌生非空目录依然拒绝。模板版本变化不通过 init 自动升级，提示单独的迁移计划。

## 6. 对已有部署的处理

`anc init` 首版只做 fresh/resume。发现已有 gateway、vault 或 LaunchAgent 时提供现状摘要，但不导入 secret、不启动第二个 gateway、不调用 `--force` 抢连接。

已有部署沿用原 M1 的独立接管流程：

1. 只读盘点现有项目、成员、目录、服务 label、data_dir 和版本；检查过程中对 secret 脱敏。
2. 整理 org 与主机配置，保留现有 wrapper、业务工具、会话和未建模选项；无法表达的差异是接管阻断项。
3. 影子渲染对比，确认 persona 与权限的行为差异；计划中的接管入口为 `deploy config --adopt`（本版尚未实现），数量变化仍要求 `--allow-scale`。
4. 备份、低峰切换、功能探针与回滚按 M1 原约定执行。

`init` 不因探测到生产部署就自动成为迁移器。现有部署的接管和全新目录初始化共享 org/render 模块，但各自有明确入口和验收。

## 7. 清单、退出码和可观测

生成的 `docs/SETUP-CHECKLIST.md` 使用固定步骤 ID：

| ID | 待办 | 证据 |
|---|---|---|
| cli | 官方 Codex CLI 与 gateway 可执行，gateway 版本固定 | 版本和实际二进制路径；必要时构建校验值 |
| auth | 本机用户完成 Codex 登录 | 官方 CLI 登录状态；`--probe` 才进行真实模型调用 |
| bindings | 飞书应用、机器人能力、长连接事件与本人 ID 配置齐全 | org 校验、凭据存在、连接测试 |
| content | 补公司简介和至少一份可核对资料 | 路由能定位、文件有来源；未填仍诚实返回尚未入库 |
| deploy | 审阅预览并应用 | 当前配置指纹、受管服务和本次启动的就绪证据 |
| message | 真人从飞书提问并查回知识 | 同一请求的入站、工具结果、回传和用户确认 |
| recovery | 服务重启后恢复连接与回复 | 新 PID、新启动批次、重启后的消息测试 |
| reboot | 决定常开/登录策略，另行做整机恢复测试 | 单独记录；服务重启不等于整机重启 |

清单是操作指引，不作为实时健康真相。doctor 每次重查；缺权限或超时显示 UNKNOWN，不拿旧 PASS 冒充当前状态。会话被归档需单独报告，建议 `/new` 或显式恢复，不能把进程存活当作可续接。

固定 gateway 的 `platform ready` 早于飞书连接成功，因此部署需同时检查当前 wrapper PID 的启动标记、各项目 ready 与 SDK 当前连接数量；只有平台初始化日志不能报告上线。SDK 日志契约变化须重新验收。相同配置重新 apply 仍检查服务，已停止的受管服务会修复启动；无法确认卸载时保留恢复日志，不报告清理成功。

init 退出码：0=初始化完成（可有部署待办），1=文件/身份/权限等初始化失败，2=参数错误。中断遵循进程信号约定并留下可恢复日志；不使用「已回滚」退出码 3，因为 init 不修改在线服务。

JSON 结果至少包含 `schemaVersion`、`status`、`vaultRoot`、`created`、`skipped`、`preserved`、`pending`、`nextCommands`；错误包含稳定 `code`、用户可理解的 `message` 和 `fix`。`status=initialized` 不能写成 `ready` 或 `deployed`。

## 8. 第一批实现任务与验收

本批交付初始化与必要的部署闭环；sync、watchdog、自动接管和自动建飞书应用仍不在本批范围。

| 顺序 | 交付 | 验收 |
|---|---|---|
| 1 | 同步已接受的架构差异；TypeScript CLI 入口、参数、结果协议 | `anc init --help`、参数负例和 JSON 输出稳定 |
| 2 | 模板、org 草稿 schema、纯函数 `planInit` | 中文名称与空格路径可用；秘密与本机路径不进入 org |
| 3 | 文件执行器、锁、manifest、恢复日志 | 重跑不覆盖；每个写入阶段中断可恢复；并发不会双写 |
| 4 | 生成 checklist，接入只读环境检查结果 | 缺 Codex/登录/飞书凭据仍生成可继续配置的骨架 |
| 5 | Codex persona/config 渲染与部署事务 | 首次/resume 权限实测；不改变未经接管的旧服务 |
| 6 | 干净 macOS 用户与飞书测试应用验收 | init→配置→doctor→deploy→读库回复→重启再回复 |

首个 PR 的必要负例：非空陌生目录、重复公司 ID/不同 vault 绑定、路径穿越、符号链接、目录被同名文件占用、manifest 损坏、权限拒绝、两进程同时 init、用户已改模板、已有 secrets、dry-run 零写入。测试必须断言用户文件字节和已有服务状态没有变化。

后续 Codex 契约测试使用固定 gateway/CLI 组合，检查实际 argv、persona 加载、首次与 resume 的权限、资料可读性、无权限写入失败、会话归档诊断；既不新写 agent loop，也不提取 OAuth token。

当前工作目录已恢复远端 Git 历史并建立开发分支；内部调研索引未随原目录提供。本草案依据现有公开设计与本机 CLI 接口整理，未抽取私有 reference deployment 代码。后续抽取私有脚本前须恢复适用的内部材料；代码按分支→PR→review→验证流程交付。公开检查须在 Git 环境执行并人工核对变更。
