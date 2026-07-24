---
name: anc-onboard
description: 创始人访谈式建库——给公司在云上建共享 vault(通用到任何行业,访谈就是行业适配器)。在创始人自己的 Claude Code 里跑,产出 vault 骨架并写入 R2。触发词:建公司知识库、初始化 vault、onboard 公司、把我们公司变 AI native、company onboarding、set up company vault、anc onboard。
---

# anc-onboard:一场访谈,建出你公司的共享 vault

## 铁律(置顶)

- 访谈产出的一切内容必须来自用户的回答,**绝不替用户编造业务事实**;没问到的写 `TBC`。
- 建库前必须确认 vault MCP 已连接(见步骤 0);没连接就先引导用户连接,不要假装写入成功。
- 不碰用户本地文件系统之外的东西;不在对话里回显 token。

## 对话即界面:进度汇报约定(每轮必守)

没有前端,对话就是全部界面。onboarding 的**每一轮回复**都必须让创始人一眼看清三件事:

1. **回复第一行永远是进度行**,格式:`【onboarding 3/5 · 资料写入】已建 5 个文件,正在写 roles/ ——接下来还差成员名单`。五个阶段:① 连接 ② 访谈 ③ 目录设计确认 ④ 写入 ⑤ 收尾交付。
2. 每轮结尾明确说**下一步需要用户给什么**(一句话,别让人猜)。
3. **断点续走靠 vault 自己**:每完成一个阶段,立即 `vault_write("company/onboarding-state.md")` 记录阶段勾选清单与已收集的关键信息摘要(author=创始人,reason="onboarding 进度")。skill 每次启动第一件事(连接确认后)就是读这个文件:存在且未完成 → 播报「上次进行到第 n 步」并从中断处继续,已完成 → 转日常使用指引。中途关掉会话、换台电脑,都不丢进度。

## 前置:vault 服务已部署

用户(或帮他的人)需要先部署一次 vault 服务(公司只做一次,5 分钟):见 `light/vault-service/README.md`。拿到两样东西:**服务地址** `https://<worker>/mcp` 和 **VAULT_TOKEN**。

## 步骤

### 0. 确认连接

让用户执行(替换地址和 token):

```bash
claude mcp add --transport http vault https://<worker>/mcp --header "Authorization: Bearer <token>"
```

然后调用 `vault_list` 验证连通。全新公司会返回「vault 为空」——正常,继续。若已有内容:先 `vault_read("company/onboarding-state.md")`——有未完成的 onboarding 就播报进度并续走;没有该文件但库里有别的内容,停下来问清楚是不是要在现有库上补建,避免覆盖。

### 1. 访谈(行业适配器,语音友好)

按顺序问,每问一轮就复述确认。问题开放,不预设行业:

1. **公司是做什么的?**(一两句话;追问:客户是谁、卖什么/做什么服务)
2. **日常最常被问的 3-5 类问题是什么?**(这直接决定数据目录怎么分——贸易行是订单/客户/报价,律所是案件/合同/判例,车队是赛程/规章/器材)
3. **有哪些高频术语/黑话?**(建术语表)
4. **手头有哪些资料?**(PDF/表格/照片/聊天记录——先登记类型,入库用 anc-ingest)
5. **团队有谁,各管什么?**(姓名/角色/关注面)
6. **哪些事实经常变?**(名单、价格表、排期——这些要进 canonical 单点文件)

### 2. 设计目录(给用户看,确认后再写)

根据回答设计 3-6 个业务目录(用问题 2 的答案命名,如 `orders/` `clients/` `cases/`),外加固定骨架:

```
CLAUDE.md            # 根路由:问题类型 → 目录/文件 对照表 + 使用纪律
CONTRIBUTING.md      # 入库规范(见步骤 3)
company/profile.md   # 公司简介(访谈产物)
company/glossary.md  # 术语表
company/team.md      # 成员与角色(canonical:人员信息只在这一份)
roles/<role>.md      # 每角色一份:职责、常见问题、口吻建议
<domain>/CLAUDE.md   # 每业务目录一份:本目录放什么、怎么命名
<domain>/_originals/ # 原件区(PDF 等,结构化 markdown 用 source_file 指回)
templates/           # 数据录入模板(复制→填→写入)
```

### 3. 逐个写入(vault_write,author=创始人名,reason="onboarding")

- **根 CLAUDE.md** 必须包含:① 公司一句话简介;② 「问题类型 → 文件」路由表(按问题 2 生成);③ 三条纪律:先按表定位再搜索、查不到就说「尚未入库」不编造、易变事实只在 canonical 文件维护。
- **CONTRIBUTING.md**:frontmatter 规范(`title` / `source_file` / `updated`)、目录与命名约定、「原件进 `_originals/`,结构化 markdown 指回原件」。
- **技能正文上载**:把本技能目录(`~/.claude/skills/anc-onboard/`)下 `vault-skills/` 里的每个 `<name>.md`,按需结合访谈结果做行业定制(尤其入库规范相关表述),写入 vault 的 `skills/<name>/SKILL.md`。**硬约定(anc-join 生成名片依赖)**:正文第一个标题下方必须保留两行——`触发词:…` 与 `简介:…`,各自单行、非空、≤200 字;上载前逐个自检,缺了就补。技能正文从此以 vault 为唯一真相:后续改技能 = 改 vault,全员即时生效。
- 其余文件按访谈内容填,没问到的字段写 `TBC`。

### 4. 收尾清单(打印给用户)

1. 每个成员的接入命令(同步骤 0 的一行命令)+ 建议他们装 `anc-join` skill(join 会自动从 vault 同步技能名片,后续公司技能更新无需任何人手动升级)。
2. 「把手头资料发给我,说『入库』」→ 走 anc-ingest。
3. 提醒:VAULT_TOKEN 就是公司数据的钥匙,只在私密渠道分发。

## 失败排查

- `vault_list` 报 401 → token 错或没配 secret,回 vault-service README §部署。
- 写入报「路径不允许」→ 目录名只用小写字母/数字/连字符,不要空格。
