# 贡献行业角色包

一个角色包描述同一行业中可复用的职责。每位成员仍使用自己的机器人；管理员在成员 persona 中选择角色。

| 包 | 角色 | 主要交付 |
|---|---|---|
| education | course-coordinator、learning-records | 排课冲突清单、带来源的学员档案摘要 |
| manufacturing | quality-coordinator、supply-planner | 批次复检交接、按需要日期排列的物料缺口表 |

## 在私有 vault 试用

从本仓库的 `templates/role-packs/<包>/<角色>/persona.md` 复制到私有 vault 的 `roles/<角色>/persona.md`。角色引用的 `projects` 目录和 `now`、`content-check` 技能应已存在。已有同名角色时先比较差异。将新增角色提交到 vault 的评审分支。只有在成员和管理员确认后，才修改该成员的 `role` 绑定。

用合成数据试跑。例如，让档案整理角色面对同名、不同编号的两条考勤记录，检查是否分开记录来源；让质量角色面对缺少复检签核的批次，检查是否保留待复检状态。普通角色在 Codex 下使用 suggest，在 Claude 下使用 dontAsk 和受限读取工具。

## 提交贡献

1. 在 `templates/role-packs/` 下使用简短的英文行业标识。角色目录名须与 frontmatter 的 `role` 一致，采用小写字母、数字和连字符。
2. 参照已有角色填写 `title`、后端权限、`vault_scope`、`skills`、会话与显示设置。正文用「职责」「风格」描述工作产物与判断依据，「术语表」可补充行业通用口径。
3. 在 PR 说明中给出适用岗位、一个合成任务、期望输出、待确认情形、所需范围和技能。使用虚构资料，删除客户名称、人员标识、内部链接和凭据。
4. 评审者分别核对两种后端权限、依赖与数据可见范围。在测试 vault 导入后验证能够渲染 persona，重复导入无差异，同名自定义角色受到保护。角色变更随仓库版本发布。团队在自己的 vault 评审升级差异。
