# 实施计划(PLAN)

版本:0.1(2026-07-24)。里程碑按「每步都有真实用户在用」排序:reference deployment(Climax Racing)始终是第一个用户,每个里程碑先在它身上落地,再泛化。

---

## M0 — 立项(本仓库现状)✅

- [x] 六路调研:内部解剖 × 2(仓库 + 生产机实勘)、外部生态 × 4(gateway 选型 / OpenClaw 品类 / 组织框架 gap 分析 / IM 平台与 harness 实测)
- [x] 关键裁决:cc-connect 之上建约定层(不 fork 不自研);官方 CLI 双 harness;一人一 bot;每 bot 一 cwd 枢轴
- [x] README + SPEC + PLAN + RESEARCH

## M1 — 抽取:`anc init` 拉起最小公司(飞书 × Claude Code)

目标:在一台干净 Mac mini 上,`anc init` + 引导 checklist 走完,得到一个能回话的 N-bot 公司。详细技术设计见 [M1-DESIGN.md](./M1-DESIGN.md)。

- [ ] 从 reference deployment 抽出 generic 部分,形成 **vault 模板仓库**(目录骨架、CONTRIBUTING、路由 CLAUDE.md/AGENTS.md 双文件、templates/)
- [ ] **org 真相源 schema**(members/ + roles/,markdown + frontmatter)与 **config 渲染器**(org → cc-connect config.toml,原子写 + 三重校验 + dry-run)
- [ ] **launchd installer**:gateway / vault-sync / watchdog 三件套 plist 生成(完整 PATH、无 SessionCreate、GUI 会话),`anc doctor` 环境诊断
- [ ] 内置角色模板库第一批(通用:经理/运营/技术/对外),persona 七段式渲染
- [ ] `anc deploy personas|skills`、`anc status`
- [ ] 验收:Climax 生产从手工脚本切到 `anc` 命令面,行为不回退;一台测试 mini 从零拉起 demo 公司 ≤ 1 小时人工时间

## M2 — 对话式 onboarding + 自动入库

- [ ] **onboarding skill**(SPEC §6 五阶段):访谈(语音友好)→ 名单 → 初始资料 → 装机 checklist(断点续走)→ 验证 + 自我介绍
- [ ] **ingest 管线产品化**:inbox 目录约定、watcher sidecar、结构化入库(schema 校验 + diff 复核门,不 bypass)、publish、摘要通知
- [ ] `anc audit [--fix]` 第一版(默认值、密钥权限、白名单、bypass 检查)
- [ ] 验收:一个非 Climax 的真实小团队(找一家设计室/贸易行/俱乐部)完整走通 onboarding 并留存使用

## M3 — 第二平台与第二 harness

- [ ] 钉钉(Stream Mode)、企业微信(智能机器人长连接)接入:主要是渲染器支持 + 逐平台建应用 checklist + 卡片降级策略
- [ ] **Codex CLI 第二后端**:Harness 接口落地(runTurn/resume/事件流),AGENTS.md persona 注入,回归两 harness 行为一致性
- [ ] per-member credential 支持(每人绑自己的订阅)
- [ ] 验收:同一 org 定义,切平台/切 harness 只改配置一行

## M4 — 运维与自我迭代闭环产品化

- [ ] watchdog / 防假绿探针 / token & 使用日报 通用化(去 Climax 专有逻辑)
- [ ] **triage 引擎**:聊天问题挖掘 → 聚类去重 → 频率信号 → 自动开 issue → 人只把关(治「反馈闭环后半段全手工」的生产头号痛点)
- [ ] skill merge 后自动部署 + 漂移检测(merged = live)
- [ ] 《整机重建 runbook》+ `anc rebuild`(config 可 git 重建,单机风险对策)
- [ ] 心跳/主动性评估(HEARTBEAT.md 模式,多 bot 错峰与预算闸)

## M5 — skill 生态

- [ ] 公司内 skill registry 约定 + eval 回归框架(周期性跑,防 skill 退化)
- [ ] role 模板库社区化(贡献指南、更多行业角色包)
- [ ] 跨公司 skill 分发的安全设计(签名 + 扫描 + pin,见 SPEC §5)——仅设计,是否实施看需求

## Experimental — ANC Peripheral 录音外设(不阻塞 M1-M5)

- [ ] software-only spike:手机录音 → Capture Session → Pipeline → 会话/知识/动作/档案/丢弃五类路由
- [ ] ANC Capture Protocol:设备身份、音频块、ACK、断点续传、会话绑定与保留策略
- [ ] YoooClaw adapter spike:`proxied` ingress、录音状态、profile/设备映射与 egress callback
- [ ] 磁吸录音卡原型:本地录音、独立电池、BLE 同步、物理键与强制录音指示
- [ ] Seeed Studio/其他 ODM 可行性:麦克风、低功耗、结构、样机、认证和量产边界
- [ ] 安全门:设备吊销、加密/重放保护、参与者授权、知识/动作人审、原始音频删除

设计见 [ANC-PERIPHERAL.md](./ANC-PERIPHERAL.md)。只有 software-only 与开发板阶段验证通过后,才决定正式里程碑和量产路线。

---

## 运营节奏

- 开发流程沿用 ha7ch 惯例:PR → Codex review → squash merge;每里程碑收口时同步 reference deployment。
- 竞争时钟(RESEARCH 结论):Claude Cowork 正向企业扩张、OpenClaw 社区随时可能有人把团队化用法产品化——M1/M2 是窗口期,目标 4-6 周内交付。
