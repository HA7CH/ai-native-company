# M1 托管运维与接管

本批只部署飞书 × 官方 Codex。普通角色使用 readonly/workspace，无需安装 Claude Code，也不需要轻型态。`init`、连接就绪、真人收到正确回复是三个不同的验收结果。

## 新装顺序

1. `anc init` 生成知识库、公司与成员定义。填写飞书绑定和本机 secrets.env，完成官方 Codex 登录。
2. `anc deploy skills` 预览；`--apply` 把角色声明的技能复制到各成员 cwd 的 `.agents/skills/`。
3. `anc doctor` 检查 org、技能、凭据权限、CLI 版本/登录、GUI 域、Git、磁盘、时区和防休眠条件。
4. `anc deploy config` 预览；`--apply` 安装 gateway、persona 与受限 CLI 适配器，等待每项目 WebSocket 连接证据。
5. 明确告警收件人后，在本机 host.json 设置 `operations.alertMember` 为成员 ID。`anc deploy operations --apply` 安装独立 shell watchdog。它使用对应机器人的私有凭据，只给该成员本人私聊告警。
6. `anc status` 同时查看 gateway、技能和运维状态。`--probe` 追加真实模型认证调用；它不发送飞书消息。真人分别提问、检查来源路径并验证恢复后回复。

watchdog 以当前进程的连接证据判断健康，不把机器人闲置时没有新日志当作故障。重启最多每小时两次，活动任务期间不强杀；异常消息两小时冷却，恢复消息单独发送。脚本不依赖 Node 或 anc。GUI 用户未登录时 LaunchAgent 不会恢复；自动登录与整机重启由负责人单独安排，anc 不记录登录口令。

## Git 同步

默认 `sync_enabled: false`，没有远端时不安装定时 pull。启用前先核对仓库可见性、当前文件和历史提交；已删除文件仍可能存在于历史。

配置 `origin` 与 tracking branch，再将公司定义设为 `sync_enabled: true`；可设 `sync_interval_min`，默认 15。重新部署 operations 后，纯 shell 同步使用 fetch + merge --ff-only。工作区有修改或分叉时保留现场并记录失败；不自动 commit、stash、reset 或 rebase。新鲜度来自最后一次成功记录，不用进程存在冒充同步成功。

选择只上传部分目录或新快照时，须先明确发布源与生产副本的关系；不能把本地 bare 仓库或无远端的副本算作远端同步验收。

## 接管现有服务

`anc init` 不接管已有业务库。准备一个本机私有 JSON 计划，列出公司 ID/名称、vaultRoot、configPath、label、logPath、codexPath、gatewayPath 和每个现有项目到成员 ID 的映射。可声明 adapterWrapper、精确 readPaths/toolPaths 和告警成员。计划不放到公开仓库。

```sh
anc adopt --plan /absolute/private/adoption-plan.json
anc adopt --plan /absolute/private/adoption-plan.json --apply
anc deploy skills --apply
anc doctor
anc deploy config --adopt
anc deploy config --adopt --apply
anc deploy operations --apply
```

`adopt --apply` 只准备 org 与私有状态，不停止旧服务。旧业务目录没有兼容 frontmatter 时，组织定义放在 vault 内的 `.anc-org/`；它是这次托管部署唯一的 org 渲染源，原有业务 Markdown 保留。主机目录和凭据仍在 vault 外。

导入器只支持明确建模的中文 Codex/飞书配置。未知选项、额外平台或多人白名单会阻断接管，不静默丢弃能力。项目名、cwd、data_dir、模型、单人白名单、进度显示、即时回复及流式预览按现状保留；旧 persona 正文纳入成员源文件。业务确认脚本可继续作为官方 CLI 的外层适配器，需固定内容哈希；脚本不得提取 OAuth 凭据或替代 agent loop。

第一次切换须 `--adopt`。准备时记录旧配置、persona 与 plist 哈希；旧文件有变化时拒绝覆盖。切换前核对活动任务，卸载旧服务后才写生成文件。新服务失败时恢复旧 persona/plist，并等待旧日志新增连接证据；恢复未验证时保留事务记录。`anc rollback` 可继续恢复，不能仅因文件写回就报告成功。旧配置中的凭据不复制到普通部署备份。

## 业务文件与附件

额外业务读取范围使用本机 `layout.members.<id>.readPaths`，可用 `denyPaths` 排除待确认数据和私有元信息。禁止授权整个用户目录、主机状态、Codex 登录目录及旧网关凭据。符号链接目标须核对实际读取路径，并在真实沙箱中验证。公司知识保持只读，workspace 只能写自己的 cwd。

需要向当前会话交付附件时，可显式启用成员 `delivery`。anc 提供窄的 stdio MCP 工具调用现有 `cc-connect send`：仅接受网关已核验的本人私聊、固定项目/收件人及 cwd 内非隐藏普通文件；拒绝越界和指向外部的符号链接。只有 `delivery_status` 与 `send_attachment` 两个工具获授权，角色 shell 仍禁止直接网络访问。发送须遵循真人本次业务请求，成功以网关回执为准。

工具配置采用官方支持的[逐工具 approval_mode](https://developers.openai.com/codex/config-reference/)。macOS 的 Unix socket 权限配置需实测，不能仅凭解析成功断言可用；相关[上游问题](https://github.com/openai/codex/issues/25416)仍需跟踪。MCP 状态探针不等于附件送达验收。

## 技能与恢复

内置 now、content-check、usage、im-send 四个技能；经理、运营、技术、对外角色模板按职责引用技能。persona 包含身份、职责、数据来源、诚实条款、风格、收资料、动态事实七段及成员补充。

技能部署保留二进制资源和执行位；默认不删除源端已移除的文件。`--name NAME --prune` 只删除该技能中以前由 anc 管理的文件，拒绝覆盖手工修改和其他来源的技能。已取消分配的旧技能也必须显式选名清理。中断用 `anc rollback skills`；运维安装中断用 `anc rollback operations`。

`anc selftest --sandbox` 使用 `com.anc.test-*` 独立 label，真实验证 launchd 安装、watchdog、无新增日志时的健康判断、失败更新及回滚，完成后清理。它不使用真实飞书应用或模型，不代替独立 macOS 用户新装与真人消息验收。

## 本批证据边界

已完成自动化回归、隔离 launchd selftest、真实 Codex 的读取边界及受限 MCP 状态探针。现场服务切换、各成员真实消息、附件送达、告警/恢复、私有远端同步和第二用户新装须逐项留证后才收口。

本地未提供原 reference deployment 和内部调研原文，不能声明已完成该生产环境的迁移。当前公司的接管证据与原 PLAN 中 reference deployment 验收分开记录。
