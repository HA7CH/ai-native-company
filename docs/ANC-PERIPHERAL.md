# ANC Peripheral:录音外设与现实输入层提案

状态:Proposed / Experimental。该方向不阻塞 M1-M5,先验证软件闭环,再决定硬件产品形态。

## 1. 定位

ANC Peripheral 是与 `Member → Bot → Agent Session` 直接关联的现实输入外设。第一种形态是磁吸录音卡/录音豆,未来也可以是手机 App、会议室麦克风、胸针或第三方设备。

它不是 Agent 主机,也不在设备端部署模型、API 或 agent loop。硬件负责可靠收音、缓存与连接;ANC 负责理解、判定、记忆和行动。

**直接关联智能体,不等于原始收音直接进入模型或 Vault。** 原始输入必须先经过隔离的 Capture Pipeline。一次录音可能产生临时会话 context、知识候选、动作事件、只读档案或丢弃结果。

```text
[ANC Peripheral]
  audio / button / device events
              │
              ▼
[Capture Session]
  device + member + bot + optional agent session
              │
              ▼
[Capture Pipeline]
  decode → segment → ASR → diarize → classify → policy
              │
              ▼
[Policy Router]
  ├── ephemeral context → Agent Session
  ├── knowledge candidate → review → ingest → Vault
  ├── action candidate → approval → Harness / Tool
  ├── archive → retention policy
  └── discard
```

核心语义:**Capture Session 是处理与路由单位,不是默认存储单位。**

## 2. 分层与所有权

| 层 | 职责 | 建议所有权 |
|---|---|---|
| Device | 麦克风、MCU、编码、本地缓存、电池、BLE/Wi-Fi | ANC 产品定义;Seeed Studio 等负责工程化/量产 |
| Capture Transport | 配对、session、音频块、ACK、断点续传、设备事件 | ANC 自有开放协议 |
| Phone / Relay Adapter | 手机连接、转发、daemon、profile、设备状态 | YoooClaw 可作为第一个实现 |
| Capture Pipeline | 转写、说话人、场景、相关性、权限和分类 | ANC |
| Policy Router | 会话注入、知识候选、动作审批、留存/删除 | ANC |
| Agent / Vault | 回合执行、组织知识和 skill 闭环 | ANC 现有架构 |

硬件厂商、手机连接实现和 Agent harness 均可替换。稳定边界是 ANC 的 Capture Protocol 与路由语义。

## 3. 设备绑定模型

```text
Company 1 ── N Peripheral
Member  1 ── N Peripheral
Bot     1 ── N Capture Session
Capture Session N ── 0..1 Agent Session
Capture Session 1 ── N Capture Event
Capture Session 1 ── N Derived Artifact
```

设备配对时绑定 `companyId + memberId + botId`;每次开始收音创建 `captureSessionId`。用户可以显式选择项目或现有 Agent Session,也可以留空,由 Pipeline 生成候选路由但不得自动跨权限边界。

```json
{
  "captureSessionId": "cap_01",
  "deviceId": "peripheral_01",
  "companyId": "demo-company",
  "memberId": "alice",
  "botId": "alice-bot",
  "agentSessionId": null,
  "projectHint": "optional-project",
  "mode": "personal",
  "retention": "delete-raw-after-review"
}
```

## 4. Capture Protocol 最小契约

MCP 是 Pipeline 之后的 Agent 适配面,不承担底层连续音频传输。底层协议至少需要以下事件:

```text
session.open
audio.chunk
marker.add
device.status
session.close
chunk.ack
sync.resume
session.cancel
```

每个音频块携带 `captureSessionId / sequence / timestamp / codec / checksum`;服务端按序 ACK,设备在确认前保留数据。协议必须支持离线录音、重连续传、幂等提交、版本协商和设备密钥轮换。

Pipeline 完成阶段处理后,再通过适配器暴露给 Agent:

- MCP Resource:经过权限过滤的转写、候选 context 与 artifact。
- MCP Tool:确认落库、绑定项目、创建待办或执行动作。
- Harness message:把批准后的内容送入目标 Agent Session。
- A2A/task adapter(可选):把长处理任务与 artifact 交给其他 Agent。

## 5. Capture Pipeline 与结果路由

Pipeline 阶段可按部署能力增减,但阶段产物必须可追踪:

1. **接收**:校验设备、序号、完整性与时间线,原始内容进入隔离 staging。
2. **音频处理**:解码、降噪、VAD、分段和可选说话人分离。
3. **转写**:生成带时间戳 transcript;不把模型推断当作事实。
4. **场景与权限**:判断个人/会议模式、参与者、项目候选和可见范围。
5. **分类**:区分会话指令、事实、决策、待办、规则、观点和无关内容。
6. **策略**:依据分类、置信度、权限与保留策略产生 route candidate。
7. **复核**:知识写入和高风险动作默认需要人确认。
8. **发布**:批准后进入现有 inbox/ingest,或交给 Harness / Tool 执行。

路由结果不是二选一的「落库/不落库」:

| 结果 | 示例 | 默认处理 |
|---|---|---|
| Ephemeral context | 「帮我查明天航班」 | 进入当前 Agent Session,不进 Vault |
| Knowledge candidate | 「报价必须附成本表」 | 人审后经 ingest 写 canonical 文件 |
| Action candidate | 建日程、发消息、创建任务 | 展示动作与目标,批准后执行 |
| Archive | 有审计价值但暂不结构化 | 加密保存,按策略到期 |
| Discard | 闲聊、重复、无权限内容 | 删除派生内容与到期原始音频 |

## 6. 硬件路线

### 6.1 第一阶段:手机中继型磁吸录音卡

设备承担:

- 2-4 个 MEMS 麦克风与必要的音频前端。
- MCU、音频编码、本地闪存和独立电池。
- 实体开始/停止键、不可被软件关闭的录音指示。
- BLE 配对、控制、状态和录音同步。
- USB-C 或磁吸充电。

手机承担账号、配对、项目/会话选择、网络上传、处理进度和人工复核。录音卡应能在手机锁屏、App 暂停或暂时离线时继续本地录音;否则只是外接麦克风,无法真正降低手机持续录音的耗电与系统限制。

提供两种工作模式:

- **Capture**:卡片本地录音,结束后批量同步。默认模式,可靠且省电。
- **Live**:经手机实时送入 Agent Session。作为增强模式,接受更高功耗和移动系统后台限制。

第一代不加入 Wi-Fi/4G。只有手机中继的需求被验证且独立联网收益明确后,才增加配网、天线与蜂窝成本。

### 6.2 Seeed Studio 的角色

[Seeed Studio](https://www.seeedstudio.com/)适合作为硬件工程与供应链候选,而不是 ANC 软件底层框架。可合作范围包括麦克风/MCU 选型、参考板与载板、天线/电源/结构设计、样机、小批量和量产测试。其 reComputer 产品线可用于早期 Linux 接入原型,但最终低功耗录音卡不应直接塞入完整 Linux 主板。

合作前需要确认:

- 麦克风阵列、拾音距离、噪声环境与音频前端经验。
- 低功耗录音、编码、闪存和 BLE 同步的参考设计。
- 电池、充电、热设计、磁吸结构与认证能力。
- 裸板、ODM、最小起订量、打样周期与固件交付边界。

## 7. YoooClaw 作为首个接入实现

[YoooClaw CLI](https://developer.yoooclaw.ai/cli/)是目前更接近 ANC 软件接入层的候选:Go 单二进制 daemon、macOS/Linux ARM64/x64 支持、录音状态事件、本地文件、profile、多 API key/`clientLabel`、结构化 JSON/NDJSON 输出,并可安装 Claude Code/Codex skill。

推荐用法是 adapter,不是把 ANC 核心绑定到其托管 Relay:

```text
[Phone / Device]
        │
[ANC-owned connection]
        │
[YoooClaw daemon: proxied]
        │ egress callback / local files / events
[ANC Capture Pipeline]
```

YoooClaw 已提供 `standalone / proxied / direct` ingress 分层;`proxied` 可关闭 daemon 自有 Relay,由宿主拥有连接并接收出站回调。ANC 可先复用其 daemon 生命周期、录音状态、profile 和 Agent-native CLI,同时保持 Capture Protocol 与组织绑定模型独立。

接入前需要共同确认或补齐:

- 原始音频/音频块 ingest,而不只接收转写结果与可选音频 URL。
- 自定义 metadata:`companyId / memberId / botId / captureSessionId / projectHint`。
- 实时状态、断点续传、幂等和服务端 ACK。
- 手机 SDK/App 的定制边界与后台行为。
- Relay 私有化或由 ANC 完整接管连接的部署方式。
- `clientLabel` 与稳定 `deviceId` 的映射和密钥轮换。
- ANC 多阶段处理状态与结果回调。

## 8. 安全与隐私铁律

- 录音必须有物理动作启动和持续可见指示;禁止隐蔽录音模式。
- 设备身份与成员身份分离,丢失设备可单独吊销。
- 传输加密、设备密钥、重放保护和音频块完整性校验为上线前置。
- 原始音频、转写、派生知识分别配置保留期,默认不永久保存原始音频。
- 原始音频与未审核转写不得直接成为 Vault 事实。
- 网页、会议发言和音频中的指令均按敌意输入处理,不能越过现有审批和权限边界。
- 共享会议模式必须记录参与者/授权状态;权限不明确时只进入隔离区。
- 外发、购买、删除、发布和权限变更等动作必须展示目标并经人审。

## 9. 渐进验证

1. **Software-only**:手机录音 → Capture Session → Pipeline → 五类路由,验证闭环。
2. **Dev board**:现成麦克风板 + 本地缓存 + BLE,验证断线和续传。
3. **Magnetic prototype**:独立电池、物理键和指示灯,实测续航、热、收音和同步。
4. **YoooClaw adapter**:以 `proxied` 模式接入,通过契约和故障注入测试。
5. **Pilot**:小团队在个人/会议两种模式试用,验证隐私、复核负担和知识命中率。
6. **Custom hardware**:需求稳定后再进入 Seeed/其他 ODM 的定制和认证。

每一阶段以前一阶段的真实数据决定是否继续,不在协议和工作流未验证前锁定外壳或量产方案。

## 10. 非目标

- 不在录音卡上部署 LLM、Agent 或组织知识库。
- 不让硬件直接写 Vault 或绕过 ingest。
- 不要求所有录音都实时处理或永久保存。
- 不把 MCP 当作底层音频流协议。
- 不把 ANC 绑定到单一硬件厂商、手机 App、Relay 或 Agent provider。
- 不改变 M1 的 Mac mini × 飞书 × Claude Code 验收范围。
