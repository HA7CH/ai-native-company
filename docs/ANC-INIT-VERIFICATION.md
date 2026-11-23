# anc init 开发版验证记录

日期：2026-11-23。范围：macOS 上的托管 Codex 初始化与部署闭环；不是完整 M1 收口。

## 已验证

- TypeScript 严格编译、零运行时依赖；源码构建和打包后的可执行入口均能初始化独立 vault。
- `pnpm test`：41 项通过，覆盖初始化、并发归属、异常恢复、配置解析、密钥轮换、部署回滚及既有代理回归。
- `pnpm run test:launchd`：1 项通过。独立测试 LaunchAgent 使用虚构网关，实测安装、更新失败、恢复旧文件和旧服务就绪，结束后卸载。
- `pnpm run test:runtime`：官方 Codex 0.171.0-alpha.13 登录下，readonly/workspace 分别完成首次 exec 与 resume。实际工具输出确认知识可读、相邻私有目录不可读、知识目录不可写；只有 workspace 可以写自己的工作目录。
- cc-connect v1.3.4 能解析渲染配置。其 `platform ready` 早于 SDK 连接成功，因此就绪检查同时要求当前 PID 的启动记录和 WebSocket 连接证据。
- 两轮 Codex 静态审查发现的服务修复、卸载确认、切换顺序、凭据恢复、初始化中断、登录目录与大日志问题均已修复，并补回归。
- `bash scripts/check-public.sh`、diff 空白检查与根 AGENTS/CLAUDE 镜像检查通过。

模型调用验证使用独立虚构资料，不使用真实公司的密钥或飞书应用。系统临时目录存在 CLI 基础访问例外，真实部署拒绝把 vault/状态目录放在那里；运行时权限测试在用户目录的独立夹具中执行。

## 交付边界

已实现 `init`、`doctor`、`deploy config`、`status`、`rollback`。`init` 只代表文件初始化；`deploy` 的连接证据不能代替真人消息验收。

仍需在干净 macOS 用户与专用飞书应用上完成：初始化 → 填绑定 → 登录 → 部署 → 提问并引用知识来源 → 重启后再次回复。整机重启恢复单独验收。

旧部署接管、vault 远端同步、watchdog、技能自动部署、其他后端及 npm 发布不属于本批已完成能力。包继续保留 `private: true`。
