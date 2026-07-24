# 轻形态 MVP:BYO Claude Code + 云上唯一一份 vault

版本:0.1(2026-07-24)。代码与 skill 见 `light/`。

## 一句话

**假设公司里每个人已经有 Claude Code(或同类 agent 工作台),我们不给任何人部署 agent——只提供「公司共享 vault + 接入口 + 三个 skill」。onboarding 访谈是行业适配器,其余全通用,它是 infra。**

## 为什么是这个形态

- 托管形态(SPEC 主线,一台 Mac mini)解决的是「给没有 AI 的团队从零拉起」;但已经人手一个 Claude Code 的团队,不需要我们再放智能体——缺的只是**公司层**:共享真相源、入库规范、角色约定。gap 矩阵里 E(一人一 bot 对应真人)、H(公司级共享真相源)两列无人占位,轻形态直击 H。
- 单机形态里「共享」是同一块磁盘给的;人手一份 clone 会有人拿旧数据。轻形态的答案:**云上只有一份**(R2),大家都连它——读永远新鲜,写立即可见,没有同步问题。
- 历史/审计不靠用户懂 git:服务端每次覆盖写自动留版本(谁、何时、为什么)。

## 架构(全部 mee7 同族技术栈)

```
每人自己的 Claude Code ──(MCP,一行接入)──► Worker(anc-vault)──► R2(唯一一份:md/PDF/JSON)
                                              │ 五工具:list/read/search/write/history
                                              └ 覆盖写自动存 _history/(author/reason)
```

- 读纪律由服务端注入:MCP `instructions` + 工具描述都写明「先读 CLAUDE.md 路由、查不到就说尚未入库」——诚实条款跟着接口走,不依赖每个人的本地配置。
- 零 token 设计保持:检索就是 list/read/search(逐文件扫描),不做 embedding;量大升级为索引(真相源永不迁库,SPEC §2.3 的升级路径原样适用)。

## 三个 skill(light/skills/)

| skill | 谁跑 | 干什么 |
|---|---|---|
| `anc-onboard` | 创始人 | 访谈(业务/常见问题/术语/团队/易变事实)→ 设计目录 → 生成根路由 CLAUDE.md、CONTRIBUTING、company/、roles/ 并写入 |
| `anc-join` | 每个成员 | 一行接入 + 自检 + 学会「问事/搜索/入库」三个动作 |
| `anc-ingest` | 任何人 | 本地解析 PDF/表格 → 按 CONTRIBUTING 生成带 source_file 的 markdown → 原件 + 文档一起入库 |

## 与托管形态(SPEC 主线)的关系

不是替代,是同一套核心资产的另一个消费端:

- vault 规范(路由 CLAUDE.md、frontmatter、canonical 纪律、_originals 溯源)两边同一套;
- 托管形态的 IM bot 将来连的也是同一个 vault(mini 上的 bot 是它的另一个客户端);
- 轻形态覆盖不了的三样留给托管形态:IM 里可被 @ 的公司 bot、不用 Claude Code 的同事、无人值守定时任务。

## 自带账号原则(infra,不是 SaaS)

每家公司把 vault 服务部署在**自己的 Cloudflare 账号**里(注册免费,R2 免费额度内基本零成本):bucket、VAULT_TOKEN、Worker 全归公司,数据主权完整,我们不运营任何中心端、不经手任何公司数据。onboarding checklist 的第一步就是「注册/登录你们自己的 Cloudflare 账号」——与托管形态「一台你们自己的 Mac mini」是同一条哲学:**运行时永远在客户自己手里,我们只提供蓝图和工具。**

## MVP 边界与下一步

1. **鉴权**:现在一司一 token → 下一步 per-member token(写入身份可信)乃至 Cloudflare Access/OAuth。
2. **搜索**:逐文件扫描 → 文件多了加索引(D1/AI Search 可选,真相仍是 R2 文件)。
3. **onboarding 深化**:访谈产物落成 org 真相源(members/roles frontmatter),与 M1 的 schema 汇合——轻形态的 vault 就是托管形态 vault 的云副本。
4. **验证状态**:MCP 协议与五工具已本地(wrangler dev + 冒烟)验证;`claude mcp add` 真机联调与首家试点公司待做。
