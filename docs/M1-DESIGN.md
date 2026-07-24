# M1 技术设计 —— `anc init` 拉起最小公司(飞书 × Claude Code)

版本:0.1(2026-07-24)。对应 [PLAN](./PLAN.md) M1,承接 [SPEC](../SPEC.md) §2/§3/§4/§9。

**设计方法**:对 reference deployment(climax-vault)做六路解剖(运维脚本 / cli+devbot / vault 结构 / persona / skills / cc-connect 配置模型),在其上产出三份独立设计(抽取优先 / schema 优先 / 运维优先),经三位评委(可交付性 / 技术正确性 / 产品验收)交叉评审后合成本稿。骨架取「抽取优先」路线(两票优胜),并入另两份中被评委点名的机制,评审抓出的事实错误已逐条修正;并已对照 `_research/` 六份调研原文(尤其 internal-repo §6 抽取分界、internal 实勘 §7 installer 覆盖清单、china-gateways §三 harness 实测)做过一轮事实校准。

**指导思想:先包装后重写。** 生产验证过的 shell 逻辑照搬参数化,anc(TypeScript)只新写「必须结构化才可靠」的部分:org 加载、渲染、校验、launchctl 编排、doctor。目标第 4 周 Climax 可切换,第 5-6 周干净 mini 拉起 demo 公司。

---

## 1. M1 边界(明确不做)

- 不做:onboarding 访谈(M2)、ingest 管线与 inbox-watcher(M2)、`anc audit`(M2)、钉钉/企微/Codex(M3)、`anc member add|remove` 命令(org 文件手编 + `deploy config` 已覆盖其机制)、心跳(M4)。
- 不写 gateway、不写 agent loop;cc-connect **pin v1.3.4**(裁决 8)。
- `[management]` / `[webhook]` / `[bridge]` 一律不启用(默认值即安全策略;生效链走 kickstart,裁决 10)。

## 2. 包结构

npm `@ha7ch/ai-native-company`,bin `anc`,`dependencies: {}`(零运行时依赖,tsc → dist/),Node ≥ 18。

```
ai-native-company/
├── package.json / tsconfig.json
├── src/
│   ├── cli.ts                  # argv 手写解析 + 命令分发 + 全局 --json;退出码约定见 §6
│   ├── commands/
│   │   ├── init.ts             # vault 骨架生成 + ~/.anc 初始化 + SETUP-CHECKLIST.md
│   │   ├── deploy-config.ts    # org → config.toml 渲染/校验/落盘/kickstart/探针(personas 为其视图)
│   │   ├── deploy-skills.ts    # vault/skills → ~/.claude/skills(rsync 语义,非破坏)
│   │   ├── status.ts           # launchd/探针/同步新鲜度/config 漂移;--usage
│   │   ├── doctor.ts           # 环境诊断清单(§5.3)
│   │   ├── rollback.ts         # 列备份 → 恢复 → kickstart → 探针(一键急救,§6)
│   │   └── selftest.ts         # --sandbox:本机沙箱真跑 launchd 全链(§8.1,发版用)
│   ├── org/
│   │   ├── schema.ts           # Company/Role/Member/Org 类型 + 逐字段校验规则表
│   │   ├── frontmatter.ts      # 极简 YAML 子集解析器(标量/字符串/数组/一层嵌套,越界报错带行号)
│   │   └── load.ts             # 扫 company/ roles/ members/ → Org 对象;引用完整性检查
│   ├── render/
│   │   ├── persona.ts          # 七段式三层叠加渲染(§4.2)+ lint(§4.2 末)
│   │   ├── routing.ts          # 扫 vault 数据目录生成路由表
│   │   ├── toml.ts             # config.toml 全量生成器 + ''' 转义纪律 + mini round-trip 解析器
│   │   └── validate.ts         # 三重校验(§4.4;吸收 cc-allow.sh 规则)
│   ├── launchd/
│   │   ├── plist.ts            # 三原型 plist 生成器(KeepAlive/StartInterval/StartCalendarInterval)
│   │   └── launchctl.ts        # gui/$UID 域 bootout→bootstrap / kickstart -k / print 解析
│   ├── doctor/checks/*.ts      # 每检查一文件,统一 {id, run, fix?, exitAdvice} 接口
│   └── util/
│       ├── atomic.ts           # 时间戳备份 + temp 同目录写 + fsync + rename;备份保留 20 份
│       ├── exec.ts             # 子进程执行接口:真实 / 记录式 fake 两实现(测试枢轴,§8.1)
│       └── log.ts              # 统一错误格式:ERROR 一行 + FIX 一行
├── templates/
│   ├── vault/                  # vault 模板仓库(§3.1)
│   ├── persona-base.md         # 公司公共层七段式骨架(§4.2)
│   ├── roles/{manager,ops,tech,external,devbot}/persona.md   # 内置角色模板库第一批
│   ├── skills/{now,im-send,usage,content-check}/SKILL.md     # generic skill 首批
│   └── scripts/{anc-sync.sh,anc-watchdog.sh,gateway.sh}      # 照搬参数化的 shell(§7)
└── test/  golden/(渲染快照) fixtures/(org 样例) negative/(校验负例)
```

模块约束:`commands/*` 只做参数解析与编排,逻辑全在下层;`render/*` 是纯函数(Org → 字符串),不碰磁盘——可测性即正确性。

**主机局部状态(不进 git)**:`~/.anc/`(700)= `host.json`(cc-connect 路径与 pin 版本、config 路径、vault 本机路径)、`secrets.env`(600)、`bin/`(gateway.sh 等渲染后脚本)、`homes/<member>/`(bot 家目录,attachments/ 在其下)、`logs/`、`backups/`。**git = org 真相,`~/.anc` = 部署参数,两者不混**——vault_root 这类单机路径绝不写进 org 仓库(org 经 git 同步到多机时路径只对一台机成立)。

## 3. org 真相源 schema(markdown + frontmatter)

裁决 SPEC 开放问题 1:markdown 为主,frontmatter 承载全部机器可读结构。frontmatter 限定为 mini 解析器可处理的 YAML 子集,越界(锚点/多行/多层嵌套)直接报错并指出行号。

### 3.1 vault 模板仓库(`anc init` 生成)

```
<company>-vault/
├── CLAUDE.md + AGENTS.md      # 五段式根路由(逐字互同):定位/Quick Facts/问题类型→文件表/高频表/目录一览
├── CONTRIBUTING.md            # 两条发布路径、五步 ingest、frontmatter 规范(统一 source_file)、四纪律
├── company/company.md         # 公司自描述(§3.2)
├── roles/<role>/persona.md    # 角色层(§3.3)
├── members/<name>/persona.md  # 成员层(§3.4)
├── skills/<name>/SKILL.md     # 内置 4 skill 起步
├── <domain>/                  # init 按占位生成 1-2 个示例数据目录(CLAUDE.md + _originals/)
├── templates/                 # 数据录入脚手架
├── scripts/                   # anc-sync.sh / anc-watchdog.sh(init 从包内模板渲染落盘)
└── docs/RUNBOOK.md            # 骨架(keychain / 假绿 / 孤儿进程三大坑预写)
```

### 3.2 `company/company.md`

```markdown
---
name: Demo Trading Co        # 显示名
id: demo                     # ASCII 前缀:launchd label com.demo.*、project 名前缀
language: zh-CN
timezone: Asia/Shanghai
platform: feishu             # v1 唯一取值
defaults:
  model: claude-sonnet-5
  mode: dontAsk              # 角色 bot 默认权限档(W1 实测项 ①,见 §10)
  auto_compress_max_tokens: 120000   # 可选;缺省 = 不渲染 auto_compress 段(W1 实测项 ④)
admins: [alice]              # member id 列表 → 所有 project 的 admin_from
sync_interval_min: 15
fallback_provider:           # 可选兜底 provider;缺省 = 不渲染 providers 段
  name: ""
  base_url: ""
  model: ""                  # api_key 走 secrets.env 的 ${ANC_PROVIDER_KEY_<NAME>}
---
一句话业务简介 + 术语表(渲染进 persona 段 1 与根 CLAUDE.md Quick Facts)。
```

**watchdog 告警 webhook 是凭据**(自定义机器人 URL 即发消息能力),不进 git:存 `secrets.env` 的 `ANC_WATCHDOG_WEBHOOK`,渲染 watchdog 脚本时经 wrapper 注入。缺失时 doctor 记 WARN(「没消息 = 没事」是反模式,SPEC §8);init checklist 把「建运维群 → 加自定义机器人 → webhook 写进 secrets.env」列为明确一步。

### 3.3 `roles/<role>/persona.md`(内置四角色 + devbot 同构)

```markdown
---
role: manager
title: 经理
model: ""                    # 空 = 继承 company.defaults
mode: dontAsk
allowed_tools: [Read, Grep, Glob, WebSearch, WebFetch]
vault_scope: [projects, clients]   # 主力数据目录:路由表置顶标「你的主力」
skills: [now, im-send]
---
## 职责
管什么、不管什么(一行 bold 列表)。
## 风格
口吻 bullet(经理给结论 + 建议动作…)。
## 术语表
保留英文的术语清单。
```

body 只允许约定的 H2 段(职责/风格/术语表),渲染器按段名取用,未知段报错——防止角色层私藏事实(SPEC §2.3 canonical registry 纪律)。`devbot` 角色内置:`mode: bypassPermissions`(与生产一致;cwd = vault 本体,git 可回滚,SPEC §3.2「devbot 才给 full」)、`allowed_tools: []`(全开)、work_dir 特判为 vault 根。校验器保证全公司恰好一个 devbot,且 bypassPermissions 仅 devbot 可用。

### 3.4 `members/<name>/persona.md`

```markdown
---
name: alice                  # ASCII id,唯一
display_name: Alice Wang
role: manager
feishu:
  app_id: cli_***
  open_id: ou_***            # 本人;渲染进 allow_from
  extra_allow_from: []       # 可选:本人之外的额外可对话者(存量部署迁移时枚举现役用户用)
  allow_chat: []             # 可选群白名单
model: ""                    # 覆盖 role/company
admin: false
disabled: false              # true = 渲染时跳过该 project(离职停用而不删档)
---
称呼偏好、语言、个人关注面(整块渲染为 persona 末段「服务对象」;可为空)。
```

**secret 不进 git**:`~/.anc/secrets.env` 里 `ANC_FEISHU_SECRET_ALICE=xxx`,config.toml 只写 `app_secret = "${ANC_FEISHU_SECRET_ALICE}"`(cc-connect 原生 `${ENV}` 替换),由 gateway.sh wrapper `source secrets.env` 后 exec 注入——config / 备份 / diff 全程无明文。

## 4. 渲染器(org → config.toml)

### 4.1 逐字段映射(每个非 disabled member → 一个 `[[projects]]`)

| config.toml 字段 | 来源 | 备注 |
|---|---|---|
| 文件头注释 | `# anc:generated v=<anc版本> inputs=<sha256> at=<ts>` | 指纹头:漂移检测免重渲染、幂等短路、`--adopt` 门的判据。**inputs = org 树 + host.json 相关字段 + gateway-extra.toml 的联合 hash**——只改主机层输入同样触发重渲染,不会被「org 未变」短路漏掉 |
| `name` | `<company.id>-<member.name>` | 顺序 = members 目录名排序 + devbot 殿后(输出确定性,diff 稳定) |
| `admin_from` | company.admins 的 open_id 逗号串 | **必须写 project 顶层**(写进 platforms.options 被上游静默忽略,渲染器硬编码位置 + 校验器专项检查) |
| `reset_on_idle_mins` | 常量 30 | |
| `[projects.auto_compress]` | **可选**:defaults.auto_compress_max_tokens 存在才渲染 | 上游已有的阈值治理特性,承接生产 wrapper 的 /compact 兜底(注意:#1111 的 reuse-mode 深层治理仍缺,非本项能补);新公司默认开,存量迁移按现状 |
| `[[projects.agent.providers]]` | **可选**:company.fallback_provider(name/base_url/model),api_key = `${ANC_PROVIDER_KEY_<NAME>}`;providers.env 可带成本控制变量 | 兜底 provider(SPEC §8);存量部署若已挂 fallback,迁移「不回退」必需 |
| `[projects.agent] type` | `"claudecode"` | |
| `options.work_dir` | `~/.anc/homes/<member>`;devbot → vault 根 | init 建目录 + attachments/ |
| `options.model` | member.model ∥ role.model ∥ company.defaults.model | 三级回退 |
| `options.mode` | role.mode(devbot = bypassPermissions) | 角色 bot 一律禁 bypass,校验器强制 |
| `options.allowed_tools` | role.allowed_tools | 空数组 = 不写该键(全开,仅 devbot 允许) |
| `options.append_system_prompt` | 渲染后 persona,`'''` 多行 literal | §4.2/§4.3 |
| `[[projects.platforms]] type` | `"feishu"` | |
| `platforms.options.app_id / app_secret` | member.feishu.app_id / `${ANC_FEISHU_SECRET_<NAME>}` | |
| `platforms.options.allow_from` | member.open_id + member.feishu.extra_allow_from + admins open_id 去重 | Set 语义(抄 access.sh);绝不渲染 `"*"` |
| `platforms.options.allow_chat` | member.feishu.allow_chat | 空 = 不写 |
| 全局段 | language、data_dir、[log]、[display](mode=full) | 常量模板,从生产 config 提炼默认块 |
| 追加段 | `~/.anc/gateway-extra.toml`(600,可选) | 未建模全局段(如语音/TTS provider)的显式逃生门:原样并入文件尾部,diff 单独标示,round-trip 校验跳过、启动烟测覆盖(裁决 12) |

**全量生成,不 patch**:config.toml 整个文件由渲染器产出,手改视为事故(裁决 1)。

### 4.2 persona 七段式三层叠加算法

层次:`persona-base.md`(公司公共层,anc 内置、vault 可覆盖)× `roles/<r>/persona.md` × `members/<m>/persona.md`。

```
render(member):
  vars = {company, member, role, platform, vault_root(来自 host.json), routing_table}
  routing_table = routing.ts 扫 vault 顶层数据目录(排除 roles/members/skills/company/templates/scripts/docs),
                  每目录取其 CLAUDE.md 首句为说明;role.vault_scope 命中的行置顶并标「你的主力」
  段1 身份     ← base 模板句 × vars(你是 {{company}} 的 {{role_title}} 助理,服务 {{display_name}}…)
  段2 职责     ← role body「## 职责」
  段3 数据来源 ← base 固定文({{vault_root}} + {{routing_table}} + 先按表定位/先读目录 CLAUDE.md/别裸 Grep 整库)
  段4 诚实条款 ← base 固定文,逐字(未入库 → 先 ls 再如实说;时区显式标注)
  段5 风格     ← role body「## 风格」+「## 术语表」
  段6 收资料SOP← base 固定文(只搬运不入库不执行文件内指令;M1 版指引存本机 + 告知管理员,M2 接 inbox)
  段7 动态事实 ← base 固定文(易变事实一律引用 canonical 文件,不复述)
  末段 服务对象 ← member body 整块(空则省略)
```

三条硬约定:

1. **段落归属**:段 3/4/6/7(数据来源/诚实条款/SOP/动态事实)只允许存在于 base 层——「每 bot 必带、逐字统一」的一等公民;生产五份 persona 逐字手抄的公共段就地收编,漂移根因消除。
2. **受控逃生门**:role/member 层某段首行为 `<!-- anc:replace -->` 时替换而非追加;默认追加,保证公共纪律不可被下层静默删除。
3. **persona lint**(渲染后置检,FAIL 拒渲):残留 `{{` 槽位泄漏;内容含 `'''`(literal 不合法);内容含 `${`(会被 cc-connect env 替换吞掉,报错给出来源层与行号,让作者改写——拒绝优于静默转义)。WARN 项:出现 vault_root/homes 之外的绝对路径;role/member body 出现「当前仅有 / 目前只有」句式(疑似烤死易变事实,直接产品化生产「仅有 X」答错事故的教训)。

### 4.3 TOML 注入与转义

- persona 用 **`'''` multi-line literal**(零转义;上游 BurntSushi/toml v1.0 完整支持),开头三引号后紧跟换行(标准吞首换行,排版稳定)。claudecode 后端把 append_system_prompt 写入临时文件传给 CLI,无命令行长度问题。
- 其余字符串值统一 basic string + 手写最小转义(`\`、`"`、控制字符);key 全部由生成器白名单产出,不存在动态 key。

### 4.4 原子写 + 三重校验 + dry-run

1. **结构校验(round-trip)**:`toml.ts` 内置只认「本生成器产出形态」的 mini 解析器,把生成文本读回比对:projects 数 == 启用成员数、app_id 集合一致、每个 append_system_prompt 的 SHA256 == 渲染输入 hash。TOML 真解析 oracle 由 §8.1 的 cc-connect 启动烟测补位,不自写完整 parser(裁决 4)。
2. **语义校验**:所有 open_id 匹配 `^ou_`;app_id 全局唯一;admin_from 在 project 顶层;每个 `${ANC_*}` 引用在 secrets.env 中存在且非空(缺 secret 拒绝上线,治「空凭据全员同挂」类事故于门外);角色 bot mode ≠ bypassPermissions(**SPEC §7 红线,无任何豁免开关**;存量部署若有角色 bot 曾以更宽档位运行,切换时一并收紧,作为已知行为变化在影子 diff 中显式列出并逐条 review);gateway-extra.toml 内凡 secret 类字段只允许 `${ENV}` 引用形态,出现明文赋值即拒(「config/备份/diff 全程无明文」的承诺覆盖 extra 段);devbot 之外 allowed_tools 非空;allow_from 无 `"*"`;文件含指纹头。
3. **差分校验**:与现行 config 对比——现行 config **无 anc 指纹且未给 `--adopt` 时拒绝覆盖**(防误杀手写生产配置,Climax 首次接管的关键防线);**新增或删除 project 均需显式 `--allow-scale`**(members 目录一次误操作不能静默上线/下线任何 bot);逐 project 给 persona/allow_from/model 变更摘要,secret 已是 env 引用,diff 可安全全文打印。

落盘流程(吸收 cc-allow.sh):时间戳备份 → temp 同目录写 + fsync → rename → `launchctl kickstart -k gui/$UID/com.<id>.gateway` → 探针(**90s** 窗口:job running、pid 存在、连续两次采样 pid 不变且 runs 不涨、gateway 日志出现每 project 的功能级就绪标志)→ 探针失败自动还原备份并再 kickstart,退出码 3。**dry-run 是默认**,`--apply` 才落盘;inputs 指纹比对短路,「无变更,跳过重启」。

**事务边界**:plist 与 config 同走时间戳备份,plist 变更失败逐单元还原、已装载单元不受影响;**首次部署**(无现行 config/备份)探针失败时不存在「回滚到旧版」,行为是 bootout 全部单元 + 保留渲染产物 + 报错退出(退出码 1,不谎称已回滚),修复后重跑 `--apply` 即可。

## 5. launchd installer 与 doctor

### 5.1 plist 生成器(plist.ts)

TS 模板函数,三原型参数化:`{label, program_args, archetype: keepalive|interval(sec)|calendar(hour,min), log_dir, extra_env}`。硬纪律内建,代码级保证而非靠人记:

- **生成器无 SessionCreate 代码路径**(丢 keychain 的头号坑)+ 单测断言产物不含该字符串 + doctor 反查线上已装 plist;
- 每 plist 显式完整 PATH(`~/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin` + doctor 探得的 node/claude 实际目录);
- StandardOut/ErrPath 显式指 `~/.anc/logs/<label>/`,建不出降级 `/tmp/anc-logs`;
- **secret 不进 plist**(plist 默认 644):gateway 经 wrapper 注入(§5.2);
- 生成后 `plutil -lint` 校验;装载一律 `gui/$UID` 域,`bootout || true → bootstrap` 幂等,重启 `kickstart -k`。

### 5.2 三件套

| Job | 调度 | 内容 |
|---|---|---|
| `com.<id>.gateway` | RunAtLoad + KeepAlive | `~/.anc/bin/gateway.sh`:`set -a; source secrets.env; set +a; exec <cc-connect> --config <path> --force`(--force = 同 config 单实例抢占,根治「孤儿进程抢 IM 连接、时好时不回」);plist EnvironmentVariables 默认注入 `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`(控成本,生产验证) |
| `com.<id>.vault-sync` | StartInterval 900 + RunAtLoad | `vault/scripts/anc-sync.sh`:git pull --ff-only;一切失败记日志后 exit 0(不触发 launchd 重试风暴);输出截断 300 字符;**成功 touch `~/.anc/last-sync-ok`**(与 watchdog 共享的「输出新鲜度 + 成功标记」探测协议) |
| `com.<id>.watchdog` | StartInterval 1800 | `anc-watchdog.sh`:**纯 shell + curl,不依赖 node/anc**(监控者不依赖被监控链路上的任何组件);查 ① gateway pid 双读稳定(间隔 5s 两次 print,pid 不变且 runs 不涨)② gateway 日志 30min 内有输出 ③ last-sync-ok < 45min;异常 → 有 webhook 则 curl 喊运维群(2h 冷却文件防刷屏),并 kickstart gateway 有界自愈(1h 内最多 2 次,超限只告警不动手);自身失败也 exit 0 |

### 5.3 `anc doctor` 检查清单

每项 PASS/WARN/FAIL,**每个 FAIL 分支必带编号的人话出路**(`exitAdvice` 是接口必填字段,测试断言缺失即失败——可用性做成可验收的工程约束);检查按依赖排序,前置 FAIL 后续标 SKIP,防噪音淹没根因。`--fix` 留 M2(M1 只读)。

① GUI 会话:`launchctl managername` == Aqua(SSH 上下文一切认证皆废,第一道闸);② claude 在 PATH + `--version`,keychain 凭据存在(`security find-generic-password`);`--probe` 才真跑一发 `claude -p` 认证冒烟(默认不烧 token;进程活 ≠ 能回话的最终裁判);③ cc-connect 存在且版本 == host.json pin(pin 漂移 → FAIL,升级雷 #1562);④ git 可用、vault 干净且与 origin 可 ff、origin 可达(分叉 = 「bot 答旧数据」头号原因);⑤ 已装 plist 扫描:无 SessionCreate、PATH 含 node/claude 目录、label 匹配但无 anc 指纹 → WARN(手改漂移);⑥ 孤儿 cc-connect 进程(ps 比对 launchd 管辖 pid)→ FAIL + kill 指引;⑦ 自动登录(`com.apple.loginwindow autoLoginUser`,未开 → WARN + 「重启自愈 vs 安全」决策说明);⑧ `pmset` 防休眠;⑨ `~/.anc` 700、secrets.env 600、secrets 键集覆盖全部 config 引用、secrets 未进 git(git check-ignore);⑩ watchdog_webhook 为空 → WARN;⑪ config.toml 存在时跑 §4.4 校验 1/2;⑫ 磁盘余量、系统时区 == company.timezone。

**keychain 红线**:keychain 口令一律不进入 anc 任何路径(代码、配置、模板、文档),doctor 只检不存;锁定 → 给 unlock 人工指引,watchdog 认证探针保证问题分钟级被喊出而非默死。

## 6. 命令面

全局约定:退出码 **0 成功 / 1 校验或诊断失败 / 2 用法错误 / 3 已应用但探针失败且已自动回滚**;`--json` 全命令支持(watchdog/CI 可消费);错误恒为两行:`ERROR: <是什么>` + `FIX: <怎么修>`;没有任何命令要求用户手改 config.toml——手改在 doctor/status 里被当作漂移事故显式点名。

| 命令 | 行为 | 幂等性 | 失败处理 |
|---|---|---|---|
| `anc init [--dir D]` | 交互问 name/id/成员概数 → 生成 vault 骨架 + git init + `~/.anc/` + secrets.env 模板 → 落盘 `SETUP-CHECKLIST.md`(建飞书应用 → 填 members+secrets → 建运维群 webhook → claude GUI 登录 → deploy --apply → status),可断点续走 | 已存在文件一律跳过并列出(`--force` 覆盖);重复跑只补缺 | 中断随时重跑从缺口继续;不产生半成品状态 |
| `anc deploy config [--apply] [--adopt] [--allow-scale]` | load org → 渲染 → 三重校验 → 默认打印语义 diff;--apply:落盘 + 确保三件套 plist 已装(内容变 → bootout+bootstrap,不变 → 跳过)+ kickstart + 探针 | 输入未变 → 指纹短路「无变更」 | 校验失败:不落盘,列全部违规项,退出 1;探针失败:自动还原备份 + kickstart 回旧版,退出 3(首次部署无备份:bootout + 报错退出 1,见 §4.4 事务边界) |
| `anc deploy personas [--apply]` | 与 deploy config 同一条流水线,但 **diff 范围硬断言**:只允许 append_system_prompt 变化,出现任何结构变化即 FAIL 并提示改用 deploy config——高频低危操作的一条永不误伤结构的窄门 | 同上 | 同上 |
| `anc deploy skills [--apply] [name…] [--prune]` | vault/skills/ 含 SKILL.md 的目录 rsync -a 到 `~/.claude/skills/`;非破坏(不 --delete);--prune 仅镜像单 skill 目录内 | rsync 天然幂等 | 无 rsync 回退 cp -R;单 skill 失败继续其余,汇总报错 |
| `anc status [--usage] [--probe]` | 一屏四区:① 三 launchd job(state/pid/双读稳定性/最近退出码)② 探针(就绪标志、时间)③ 同步(last-sync-ok、与 origin 落后数)④ 漂移(config 的 inputs 指纹 vs 当前输入重算;skills 目录差异计数);--usage 附 headless `claude -p "/cost"`(headless 唯一可用的内置命令);--probe 追加实时认证探针 | 只读 | 任一 FAIL/DRIFT → 退出 1(watchdog/监控可直接消费);探测超时标 UNKNOWN 不误报 |
| `anc doctor [--probe]` | §5.3 清单 + 总评(READY / N 项待修) | 只读 | 有 FAIL → 退出 1 |
| `anc rollback [<ts>]` | 列 backups/ → 恢复指定(默认最近)备份 → kickstart → 探针 | 重复恢复同备份无副作用 | 探针仍失败 → 打印「终极出路」:down 全部单元 + 人工 checklist;非技术创始人的一键急救 |
| `anc selftest --sandbox` | 发版/装机自检:`com.anc.test.*` 前缀 + mock gateway(30 行脚本打就绪标志)真实走 bootout/bootstrap/kickstart/探针/回滚全链,跑完自动清理 | 自清理 | 任一环节失败即报,不影响生产单元 |

## 7. 从 climax-vault 抽取清单

> 抽取源标注:reference deployment 仓库的**本地 checkout 可能显著落后其 origin/main**——抽取前先 `git fetch origin` 并以远端为准;个别脚本(persona 部署、watchdog)在未合并分支或仅存在于生产机,**具体分支与位置见本地内部资料 `_research/README-INTERNAL.md` 的清单**(不写进本公开文档)。

| climax 源 | → anc 模块 | 方式 |
|---|---|---|
| `scripts/sync-vault.sh` | `templates/scripts/anc-sync.sh` | **照搬**,路径参数化;追加 last-sync-ok 标记 |
| `scripts/launch-agents.sh` up/down/status 骨架 | `src/launchd/launchctl.ts` | 逻辑照搬,TS 重写(需结构化解析 print 输出) |
| ingest/install 脚本里的 plist heredoc + 注释纪律 | `src/launchd/plist.ts` | 重写为生成器,三纪律(禁 SessionCreate/显式 PATH/显式日志)内建 + 单测断言 |
| `scripts/deploy-skills.sh` | `commands/deploy-skills.ts` | 语义照搬(TS 薄封装调 rsync) |
| persona 部署脚本(未合并分支,见内部清单) | `render/*.ts` | **重写**:从「patch 单行」升级为全量生成;备份/round-trip/全匹配否则拒写/dry-run 五教训全保留 |
| `cc-allow.sh` | `render/validate.ts` + `util/atomic.ts` | 规则吸收(^ou_ 校验/原子替换/结构校验/自动 kickstart) |
| `health-probe.sh` | `status`/探针逻辑 | 机制吸收:launchd running + 进程存在 + 日志出现每 project 就绪标志,三重交叉 |
| watchdog 脚本组(未合并分支,见内部清单) | `templates/scripts/anc-watchdog.sh` | 机制照搬参数化(新鲜度 + 探针 + 主动告警 + 冷却;独立 launchd) |
| `cc-connect-status.sh` | `commands/status.ts` | 一键状态面板的信息面参考 |
| `access.sh` Set 语义白名单 | member frontmatter + 渲染 | 机制吸收,脚本废弃 |
| 根/目录 CLAUDE.md 五段式、CONTRIBUTING、`_originals/`+source_file 约定 | `templates/vault/` | 参数化模板(领域名词换占位) |
| `agents/*/CLAUDE.md` 七段骨架 | `templates/persona-base.md` + `templates/roles/` | 逐字公共段收进 base 层,角色差异进 role 模板(§4.2 归属约定即由此提炼) |
| skills `now`/`usage`/`content-check`/`lark-send`(部分在 worktree 分支) | `templates/skills/`(lark-send → im-send) | now/usage 近照搬;im-send/content-check 参数化;铁律段/数据源表/触发词写法进 skill 模板规范 |
| `usage.sh` A 段(headless /cost) | `status --usage` | 照搬;B/C 段(jsonl 去重成本核算)留 M4 |
| `migrate-to-this-mac.sh` 骨架 | `doctor` + init checklist | 机制吸收(环境检查/钉版本/trap INT 引导),不搬代码 |
| `claude-persona-wrapper.sh` | 不抽 | cc-connect 路径无 wrapper 位;阈值 compact 由 `[projects.auto_compress]` 承接;`--add-dir` 缺口记入上游 PR 清单;归档为 M3 直驱 harness 资产 |
| `ingest-inbox.sh`、inbox 三态目录、`vault.sh` | M2 | 不动 |
| `cli/`、`worker/` | 不抽 | 已降级为 off-box 回退 / M1 外 |
| **绝不搬** | — | 任何口令/凭据、生产绝对路径与主机信息、真实人名/app_id/open_id、业务领域 schema |

## 8. 测试与验收

### 8.1 没有第二台 mini 怎么测

1. **golden / 单元(CI: GitHub Actions macOS runner)**:org fixture → config.toml 快照对拍(确定性输出是前提);persona 转义 fuzz(中文/emoji/引号/`'''`/`${`/裸换行);校验负例集(admin_from 错层、重复 app_id、secret 未定义、bypass 越权、无指纹覆盖、未给 --allow-scale 的增删)每例必须被对应校验器拦下;plist 生成 → `plutil -lint` + 断言无 SessionCreate。
2. **记录式 fake exec 注入层**:`util/exec.ts` 双实现,launchd/git/claude 调用在测试中断言「发出了什么命令序列」(bootout→bootstrap 顺序、gui 域前缀)而不真执行——installer 编排逻辑 CI 可全测。
3. **`anc selftest --sandbox`**(launchd 真行为的唯一真实测试,进发版 checklist):`com.anc.test.*` 前缀 + mock gateway 真实走 bootout/bootstrap/kickstart/探针/回滚全链,自动清理。
4. **cc-connect 当 TOML oracle**:渲染产物 + 假 secret 启动真 cc-connect,短窗口内无 config parse error 即结构合法(随后 kill)——零依赖拿到全量真解析验证(fail-fast 行为属 W1 实测项 ③)。
5. **本机第二 macOS 用户** = 穷人版干净机:独立 gui launchd 域、独立 HOME/keychain,GUI 登录一次后全流程真跑 init→doctor→deploy;doctor 的每个 FAIL 提示就是 onboarding checklist 的验收素材。

### 8.2 Climax 切换(验收 1:行为不回退,目标第 4 周)

1. 生产机装 anc,`doctor` 全绿(顺带揪出孤儿进程/版本漂移)。
2. 人工一次性把现行 config.toml 反抄成 members/roles/company(**预算半天**——每份 persona 要按新分层拆段核对,不是抄字段);secrets 抄进 `~/.anc/secrets.env`。gateway label 沿用现行值(host.json 可配),**不建第二个 gateway 抢 IM 连接**。
3. **影子渲染**:`anc deploy config`(dry-run)反复迭代,直到与生产 config 的 diff 仅剩「格式/排序/指纹头」级、语义 diff 为空——这一步本身就是渲染器对生产的最强回归。
4. 低峰 `--apply --adopt`(现行 config 无指纹,首次需显式接管);切换顺序低风险先行:先 vault-sync(观察两个周期)→ watchdog → 最后 gateway;全部 bot 在 IM 里逐个实测回话。**接管范围仅三件套**:存量部署的写侧单元(inbox-watcher/ingest)与 gateway 运行态(内置 cron、会话、agent-prompts)原样保留不触碰(M2 才接管写侧);fallback provider、语音等能力按现状渲染或经 gateway-extra 并入。切换的目标是「只换命令面、不换运行时行为」,唯一例外是权限档收紧(裁决 13):作为已知行为变化显式列出、逐条 review。
5. 回退双保险:`anc rollback` 一条命令秒级还原 + 旧脚本/旧 plist 原样保留一周可 bootstrap 旧栈。
6. **演练清单**(并行观察一周内完成):人为 kill gateway → KeepAlive 自愈且 watchdog 告警恰一次;故意改坏 org → 三重校验拦截;rollback 实弹演练一次。之后旧脚本归档,宣布「手改 config 视为事故」生效。

### 8.3 demo 公司(验收 2:干净 mini ≤ 1 小时)

测试用户账号 + 飞书测试企业 2 个自建应用,从 `anc init` 到两个 bot 回话计时。人工时间预算:建应用 30min、其余 ≤ 20min;超时项回灌 checklist 措辞。计时表进 docs。

## 9. 风险与裁决点

1. **config 全量生成 vs patch 现有文件**:选全量。patch 意味着承认手工 config 并存,正是「双源手抄」生产头号事故的根因;接管存量部署的代价由 `--adopt` 门 + 影子渲染流程承担(存量规模小,可承受)。
2. **persona 注入:append_system_prompt 内联 vs bot 家目录 CLAUDE.md**:选内联——现行 cc-connect gateway 形态已生产验证 5 周(多 bot 矩阵 8 周、vault 13+ 周,证据分开记账);work_dir 下 CLAUDE.md 的加载语义未经生产验证,两路并存会双注入。CLAUDE.md 路径(免重启生效、天然双 harness)列为 M3 与 Codex 一起重估。**SPEC §2.2 已同步注记此裁决**(cwd 的 persona 挂载语义用于直驱 harness 形态;经 gateway 部署时 persona 经渲染内联),不再构成与 SPEC 的偏离。
3. **secret 走 `${ENV}` 引用 + wrapper source vs 明文写 config**:选 ENV 引用——config/备份/diff 全程无明文。cc-connect 对未定义变量的替换行为未知(W1 实测项 ②),校验器已强制「每个引用在 secrets.env 非空」兜底;若实测异常,回退明文 600 方案只改 toml.ts 一处。
4. **TOML 校验不引依赖**:自写 mini round-trip(只认自家产出形态)+ cc-connect 启动烟测当真解析 oracle,不写完整 TOML parser(为过上游 2211 行 example 语料写完整 parser 是 4-6 周窗口内的隐性大坑)。畸形手改文件不在保护范围——全量生成模式下手改本身即事故。
5. **shell 照搬 vs 全 TS**:sync/watchdog/gateway wrapper 保 shell——launchd 直跑无 node PATH 心智负担,sync 逻辑已长期生产验证,且监控者(watchdog)不得依赖被监控链路上的组件(node/anc);渲染/校验/launchctl 编排必须 TS(要结构化和可测)。
6. **deploy personas 是同管线的窄门而非独立实现**:一条管线两个视图,不存在第二条上线路径;diff 范围硬断言给高频低危操作防误伤。
7. **watchdog 自动 kickstart**:有重启风暴风险,冷却文件(1h ≤ 2 次)+ 超限只告警;watchdog 独立 launchd 单元,绝不挂在 gateway 自己的调度里。
8. **cc-connect pin v1.3.4 而非 v1.4.1**:#1562(多飞书 app 共享 WS 丢第二 bot 消息)在 1.4.x 仍 open,1.3.4 是唯一带多 bot 生产实证的版本;修复 PR #1563 已 QA approved,merge 后按升级回归清单评估(host.json 记 pin,doctor 校验)。代价:1.4.0 的 `cmd` 字段等新特性不用,M1 也不需要。
9. **routing 表由目录扫描生成 vs 手写**:选生成(目录 CLAUDE.md 首句)。质量上限低于手写,但根治「persona 路由表与 vault 实况漂移」;压力给到正确的地方(vault 数据纪律)。
10. **[management] API 不启用,生效链 = kickstart -k**:reload 端点覆盖范围上游未完全文档化,且少开一个带 token 的端口符合「默认值即安全策略」;kickstart 生产验证。代价:deploy 打断在跑会话 → dry-run 默认 + 建议低峰 --apply;M2 audit 落地后再评估 reload。
11. **doctor 绝不代管 keychain 口令**:救火路径依赖明文口令是设计上必须堵死的形态;自动登录(GUI 会话常在)是官方且可解释的替代,做成决策项呈现。
12. **未建模字段的显式逃生门(gateway-extra.toml)**:全量生成制下,上游的语音/TTS 等未建模全局段若无出口,存量部署迁移就会丢能力。放本机层 `~/.anc/gateway-extra.toml`(600)原样并入,diff 单独标示、round-trip 跳过、烟测覆盖;**extra 段内 secret 同样只允许 `${ENV}` 引用**(校验器强制,§4.4 校验 2),明文赋值即拒——「config/备份/diff 全程无明文」的承诺无例外。逃生门是显式声明的,不破坏「渲染是唯一上线路径」。
13. **迁移期权限档不豁免**:SPEC §7「角色 bot 一律不授予 bypassPermissions」是无例外红线,校验器不提供任何绕过开关。存量部署若有角色 bot 曾以更宽档位运行,切换时一并收紧到 SPEC 档位——这是「切换不回退」验收中唯一被允许且被要求的行为变化,在影子 diff 中显式列出、逐条 review、切换后重点观察。若实测收紧导致工作流不可用,处置是补 allowed_tools 白名单,不是回退权限档。

## 10. W1 实测清单(设计中的未验证假设,第一周内出结论)

| # | 假设 | 验证法 | 不成立时的回退 |
|---|---|---|---|
| ① | `mode: dontAsk` 在 pin 的 1.3.4 被接受并正确透传(claude 本体的 dontAsk 档已实测存在;风险仅在 cc-connect 1.3.4 的档位白名单) | 1.3.4 二进制 + 烟测 config 实跑 | `default`/`acceptEdits` + allowed_tools 白名单组合 |
| ② | `${ENV}` 未定义变量的替换行为(替空?保留字面?报错?) | 烟测 config 引用未定义变量观察 | 回退明文 600 方案(仅改 toml.ts) |
| ③ | cc-connect 对 parse error 快速失败(烟测 oracle 的前提) | 喂坏 config 计时 | 烟测窗口拉长 / 改为日志关键字判定 |
| ④ | `[projects.auto_compress]` 在 1.3.4 的字段名与语义(该段已设计为可选渲染) | 1.3.4 源码/文档核对 + 烟测 | 缺省不渲染即可,上下文治理登记为 M2 缺口 |
| ⑤ | gateway 空闲时是否有周期性日志输出(watchdog「30min 内有输出」新鲜度探测的前提) | 烟测实例空闲观察 | 改用就绪标志时间戳 + 认证探针,不依赖日志频率 |

## 11. 排期(4 + 2 周)

- **W1**:org schema + frontmatter + 渲染器 + golden;W1 实测清单(§10)全部出结论。
- **W2**:三重校验/原子写/launchctl/plist + deploy config/skills + selftest --sandbox。
- **W3**:init + status + doctor + rollback;第二用户账号全流程真跑。
- **W4**:Climax 影子渲染与切换(§8.2)+ 修尾。
- **W5-6**:demo 公司计时验收(§8.3)+ 演练清单收口 + 文档回灌(RUNBOOK、checklist 措辞)。

超纲即砍的顺序(竞争时钟优先级):selftest 沙箱可降级为手工 checklist → status --usage 可后移 → 内置角色模板库可先出 2 个(manager/devbot)。渲染器 + 校验 + doctor + Climax 切换四件事不可砍——它们分别是本设计的资产、防线、出路与证据。
