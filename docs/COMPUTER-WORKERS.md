# Computer Worker 架构提案

状态:Experimental / 非 M1 阻塞项。本文只定义扩展边界,不承诺任何厂商当前产品具备无人值守部署能力。

## 1. 问题与定位

ANC 的默认 harness 擅长文件、代码与命令行工作,但部分业务系统只暴露图形界面。Computer-capable agent 可以通过虚拟桌面完成浏览器、表格、演示文稿和内部应用中的最后一公里操作。

**Computer 不是新的 harness,而是一类可选执行能力。** Claude、Codex 或其他 agent 只要能操作受控桌面,都应通过同一个 `ComputerProvider` 边界接入。ANC 不复刻厂商的视觉模型、agent loop 或桌面控制协议。

```text
[Member Bot]
     │ 先由 Harness 规划、检索并生成结构化任务
     ▼
[Computer Router] ── policy / approval / capability match
     │
     ├── [Worker A: browser]
     ├── [Worker B: office]
     └── [Worker C: internal-app]
             │
             └── artifact + audit event → inbox / vault
```

这保持现有主线不变:IM、persona、官方 CLI harness 与 markdown vault 仍是控制面和真相源;Computer Worker 只是执行面。

## 2. 部署模型

### 2.1 Headless 控制面

网关、vault、调度、审计和绝大多数 bot 回合不需要图形界面,可继续运行在 Mac mini,也可在未来运行于 Linux 主机或隔离容器。

### 2.2 虚拟桌面 Worker

需要屏幕交互的任务派给独立 worker。物理主机可以没有显示器,但 worker 内部必须拥有厂商所需的图形会话或虚拟显示器。每个并发 worker 是独立 OS/用户会话,因此不存在多个 agent 抢同一个桌面的语义冲突;容量约束转化为 CPU、内存、磁盘和厂商账号并发限制。

不把「一人一 bot」机械映射成「一人一常驻桌面」。默认使用按能力划分的共享 worker 池;只有权限或账号隔离要求较高时,才为成员或角色保留专属 worker。

## 3. Provider-neutral 接口草案

```ts
type ComputerCapability =
  | "browser"
  | "desktop"
  | "office"
  | "file-transfer"
  | "screenshot";

interface ComputerProvider {
  id: string; // provider 名称来自配置,核心层不穷举厂商
  capabilities: ComputerCapability[];

  health(): Promise<ComputerWorkerHealth>;
  runTask(task: ComputerTask): AsyncIterable<ComputerEvent>;
  cancel(taskId: string): Promise<void>;
}

interface ComputerWorkerHealth {
  status: "offline" | "starting" | "ready" | "busy" | "draining" | "quarantined";
  mode: "service" | "interactive";
  workerId: string;
  detail?: string;
}

interface ComputerTask {
  id: string;
  memberId: string;
  objective: string;
  capabilities: ComputerCapability[];
  inputArtifacts: string[];
  outputDir: string;
  policy: "observe" | "draft" | "commit";
  deadlineMs: number;
}

type ComputerEvent =
  | { type: "started"; workerId: string }
  | { type: "approval-required"; action: string; screenshot?: string }
  | { type: "artifact"; path: string }
  | { type: "audit"; action: string; target?: string }
  | { type: "result"; summary: string }
  | { type: "failed"; code: string; message: string };
```

接口刻意不包含坐标、截图循环或模型调用细节:这些属于 provider 自己的 agent loop。核心层只负责派单、策略、审批、产物回收和审计。

## 4. 路由规则

1. **连接器/API 优先**:有稳定 API 或 MCP 时不使用屏幕自动化。
2. **CLI 次之**:文件与开发任务默认留在 Harness。
3. **Computer 兜底**:只有 GUI-only 流程才进入 worker 池。
4. **能力匹配**:router 依据任务所需能力、目标应用、身份范围和 worker 健康状态派单。
5. **失败不静默降权**:worker 不可用时返回明确失败,不得自动换到权限更高的 worker。

## 5. 隔离与安全约束

- 一个活跃 worker 同一时刻只执行一个 Computer task。
- worker 不直接挂载完整公司 vault;输入经 staging 目录显式复制,输出只写任务专属目录。
- 登录态按成员或服务身份声明,不得让共享 worker 隐式继承管理员浏览器资料。
- `observe` 只读观察;`draft` 可填写但不可提交;`commit` 涉及外发、购买、删除、发布或权限变更时必须过人审。
- 所有任务记录发起 member、provider、worker、输入摘要、审批与输出 artifact;截图可能含敏感信息,采用短保留期并与 vault 分开。
- 网页和文档内容按敌意输入处理。Computer 不绕过现有 inbox/ingest 边界,也不得把屏幕内容直接提升为公司事实。

## 6. 生命周期与容量

worker 状态机为 `offline → starting → ready → busy → draining → offline`,异常进入 `quarantined`。router 只向 `ready` 实例派单;升级和凭据轮换先 drain。

容量按**并发图形任务数**而非团队人数规划。必须实测每个 provider 的空闲内存、任务峰值、磁盘增长、冷启动时间和账号并发规则后再设置上限;本文不写死跨厂商资源数字。

## 7. 渐进落地

1. **Spike**:单 worker、单应用、人工发起,只回收截图与文件。
2. **Adapter**:实现一个 provider adapter,补健康检查、超时、取消与审计。
3. **Router**:引入能力匹配和 staging 目录,仍保持 `draft` 默认。
4. **Pool**:验证虚拟桌面并发与资源曲线后才引入 worker 池。
5. **Production gate**:回放测试、提示注入测试、凭据隔离和人工审批全部通过后,才允许有限 `commit`。

在厂商没有稳定的程序化启动、状态读取和取消接口时,对应 adapter 只能标为 `interactive`,不能伪装成常驻服务。

## 8. 非目标

- 不让 GUI 自动化取代稳定 API、MCP 或 CLI。
- 不在本库实现视觉模型、截图识别或鼠标键盘驱动。
- 不承诺在普通 Linux VPS 上运行某个仅支持桌面端的厂商产品。
- 不因 Computer Worker 引入敌意多租户、K8s 或公网 SaaS 化。
- 不改变 M1 的 Mac mini × 飞书 × Claude Code 验收范围。
